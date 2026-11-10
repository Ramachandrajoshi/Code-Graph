/**
 * Looking backwards from a position in a source file.
 *
 * Every doc-comment hook asks the same question — "what is written just above
 * this definition?" — and the obvious way to answer it is to slice the file up
 * to the definition and split or regex the result. That is linear in the size
 * of the file *per definition*, so a file with n definitions costs n times its
 * own length: quadratic, and it was 40% of total index time on a large repo
 * (one `/\s*$/` over the prefix, retried at every whitespace run, was the
 * single hottest thing in the profile).
 *
 * These helpers read only as far back as the answer actually requires, which
 * for a doc comment is a few lines.
 */

const WIDE_SPACE = /\s/;

/** Same character class as the regex `\s`, without running a regex per char. */
function isSpace(code) {
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  return code > 127 && WIDE_SPACE.test(String.fromCharCode(code));
}

/**
 * Index just past the last non-whitespace character before `end`.
 * `source.slice(0, trimEndIndex(source, end))` equals
 * `source.slice(0, end).replace(/\s*$/, '')`, at the cost of the trailing
 * whitespace only.
 */
export function trimEndIndex(source, end) {
  while (end > 0 && isSpace(source.charCodeAt(end - 1))) end--;
  return end;
}

/**
 * The complete lines above `offset`, nearest first.
 *
 * Yields exactly what `source.slice(0, offset).split('\n')` holds once the
 * partial line containing `offset` is dropped, read from the bottom up — but
 * lazily, so a caller that stops at the first non-comment line never touches
 * the rest of the file.
 */
export function* linesAbove(source, offset) {
  if (offset <= 0) return;
  let end = source.lastIndexOf('\n', offset - 1);
  while (end !== -1) {
    // lastIndexOf clamps a negative start to 0, which would find the newline
    // at index 0 again and never terminate.
    const start = end > 0 ? source.lastIndexOf('\n', end - 1) : -1;
    yield source.slice(start + 1, end);
    end = start;
  }
}
