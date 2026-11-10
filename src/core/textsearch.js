/**
 * Literal text search, answered in terms of symbols.
 *
 * Some questions are not about a symbol at all: where is this error message
 * produced, which code reads this environment variable, where is this URL
 * built. Those were the reason an agent with cgraph still reached for grep —
 * and grep answers with bare lines, which then have to be opened one by one to
 * learn what each line is part of.
 *
 * This scans the indexed files for the text and reports each hit under the
 * symbol that contains it, with that symbol's line range. One call says both
 * "it is on line 212" and "that is inside `Client#connect`, lines 190-240" —
 * which is what the follow-up read would have been for.
 *
 * It reads the files from disk at query time. Nothing about file contents is
 * stored in the index beyond the words in function bodies, so a scan is the
 * only way to answer a question about exact text. Two things keep that fast:
 * files are read many at a time (opening a file is mostly waiting, and the
 * waits overlap), and matching runs over the raw bytes, so only the handful of
 * lines that are actually returned are ever decoded. The scan is still bounded
 * by a time budget, and says so when the budget ends it early.
 */

import { readFile } from 'node:fs/promises';
import { absFromRoot } from './paths.js';
import { displayName } from './search.js';

/** How long a scan may run before it reports what it has and stops. */
const TIME_BUDGET_MS = 2500;

/** Files being read at once. */
const READ_AHEAD = 48;

/** Longest matching line shown; the rest is a read away. */
const LINE_CHARS = 160;

const NEWLINE = 10;

/**
 * @param {object} store
 * @param {string} root
 * @param {string} needle  literal text, not a pattern
 * @param {object} [opts]
 * @param {string} [opts.path]   path prefix filter
 * @param {string} [opts.lang]
 * @param {number} [opts.limit]  most matching lines to return (default 40)
 * @param {number} [opts.timeBudgetMs]
 * @returns {Promise<{ matches: Array, total: number, files: number,
 *            scanned: number, candidates: number, timedOut: boolean }>}
 */
export async function textSearch(store, root, needle, opts = {}) {
  const { path = null, lang = null, limit = 40, timeBudgetMs = TIME_BUDGET_MS } = opts;
  const result = { matches: [], total: 0, files: 0, scanned: 0, candidates: 0, timedOut: false };
  if (!needle) return result;

  // Everything the walk kept as text. Binary, oversized, minified and
  // generated files are left out for the reason they were never parsed: a hit
  // inside a bundle is noise, and usually thousands of them.
  const files = store.all(
    `SELECT id, path, lang, parsed FROM files
      WHERE (skip_reason IS NULL OR skip_reason IN ('no-queries', 'no-language')
             OR skip_reason LIKE 'parse-error%')
      ORDER BY parsed DESC, path`
  ).filter((f) => (!path || f.path.startsWith(path)) && (!lang || f.lang === lang));
  result.candidates = files.length;

  const matcher = makeMatcher(needle);
  const started = Date.now();

  // Reads are issued ahead of the file being examined and consumed in order,
  // so results come out in the same order however the reads happen to finish.
  const reads = new Map();
  let primed = 0;
  const readAhead = (upTo) => {
    for (; primed < files.length && primed <= upTo; primed++) {
      reads.set(primed, readFile(absFromRoot(root, files[primed].path)).catch(() => null));
    }
  };

  for (let i = 0; i < files.length; i++) {
    if ((i & 15) === 0 && Date.now() - started > timeBudgetMs) {
      result.timedOut = true;
      break;
    }
    readAhead(i + READ_AHEAD);
    const buf = await reads.get(i);
    reads.delete(i);
    result.scanned++;
    if (!buf) continue; // Deleted since it was indexed; the next refresh evicts it.

    const hits = matcher(buf);
    if (!hits.length) continue;
    result.files++;

    const file = files[i];
    // Symbols are only looked up for files that actually matched.
    const symbols = file.parsed ? symbolsOf(store, file.id) : [];

    let line = 1;
    let counted = 0;      // bytes already scanned for newlines
    let lastLine = 0;
    for (const at of hits) {
      // Advance the line counter to the hit rather than splitting the file.
      for (let nl = buf.indexOf(NEWLINE, counted); nl !== -1 && nl < at; nl = buf.indexOf(NEWLINE, counted)) {
        line++;
        counted = nl + 1;
      }
      // Several hits on one line are one line to read.
      if (line === lastLine) continue;
      lastLine = line;
      result.total++;
      if (result.matches.length >= limit) continue;

      const lineStart = buf.lastIndexOf(NEWLINE, at - 1) + 1;
      let lineEnd = buf.indexOf(NEWLINE, at);
      if (lineEnd === -1) lineEnd = buf.length;
      result.matches.push({
        path: file.path,
        line,
        text: clip(buf, lineStart, lineEnd, at),
        symbol: enclosing(symbols, line),
      });
    }
  }

  return result;
}

/**
 * Build `buf -> byte offsets of every match`.
 *
 * Smart case, as ripgrep does it: an all-lowercase query matches any case, one
 * with a capital in it is taken to mean exactly that.
 */
function makeMatcher(needle) {
  const sensitive = needle !== needle.toLowerCase();

  if (sensitive) {
    const bytes = Buffer.from(needle, 'utf8');
    return (buf) => {
      const out = [];
      for (let at = buf.indexOf(bytes); at !== -1; at = buf.indexOf(bytes, at + bytes.length)) out.push(at);
      return out;
    };
  }

  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(needle)) {
    // Case-insensitive, ASCII needle. Viewing the bytes as latin1 costs no
    // decoding, keeps string offsets equal to byte offsets, and cannot alter
    // an ASCII match: multi-byte UTF-8 sequences never contain ASCII bytes.
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return (buf) => {
      const text = buf.latin1Slice(0, buf.length);
      const out = [];
      re.lastIndex = 0;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        out.push(m.index);
        if (m[0].length === 0) re.lastIndex++;
      }
      return out;
    };
  }

  // Case-insensitive with non-ASCII characters: case folding has to happen on
  // decoded text, and the offsets then have to be mapped back to bytes.
  const target = needle.toLowerCase();
  return (buf) => {
    const text = buf.toString('utf8');
    const hay = text.toLowerCase();
    // Lowercasing can change a string's length (a handful of characters do);
    // offsets would then point at the wrong place, so such a file is skipped
    // in favour of never reporting a wrong line.
    if (hay.length !== text.length) return [];
    const out = [];
    for (let at = hay.indexOf(target); at !== -1; at = hay.indexOf(target, at + target.length)) {
      out.push(Buffer.byteLength(text.slice(0, at), 'utf8'));
    }
    return out;
  };
}

function symbolsOf(store, fileId) {
  return store.all(
    `SELECT n.name, n.qname, n.kind, n.start_line, n.end_line, f.path
       FROM nodes n JOIN files f ON f.id = n.file_id
      WHERE n.file_id = ? AND n.kind != 'module'
      ORDER BY n.start_line, n.end_line DESC`,
    fileId
  );
}

/** The innermost symbol whose range covers `line`, or null at file level. */
function enclosing(symbols, line) {
  let best = null;
  for (const s of symbols) {
    if (s.start_line > line) break;
    if (s.end_line >= line) best = s; // later rows start later, so nest deeper
  }
  return best;
}

/** One line of source, trimmed, and windowed around the hit when it is long. */
function clip(buf, lineStart, lineEnd, at) {
  // A minified or data line can be megabytes; decode only around the hit.
  const from = Math.max(lineStart, at - LINE_CHARS * 2);
  const to = Math.min(lineEnd, at + LINE_CHARS * 2);
  let text = buf.toString('utf8', from, to).replace(/\s+/g, ' ');
  const cutLeft = from > lineStart;
  const cutRight = to < lineEnd;
  if (!cutLeft) text = text.trimStart();
  if (!cutRight) text = text.trimEnd();

  if (text.length > LINE_CHARS) {
    const center = Math.min(text.length, at - from);
    const start = Math.max(0, Math.min(text.length - LINE_CHARS, Math.floor(center - LINE_CHARS / 3)));
    const end = start + LINE_CHARS;
    return (start > 0 || cutLeft ? '…' : '') + text.slice(start, end) + (end < text.length || cutRight ? '…' : '');
  }
  return (cutLeft ? '…' : '') + text + (cutRight ? '…' : '');
}

/**
 * Render text matches grouped by file, then by enclosing symbol.
 *
 * The symbol is printed once, above the lines it contains, with its range —
 * the thing a grep hit never tells you and the reason each one usually costs a
 * second call.
 */
export function renderTextMatches(result, needle) {
  const { matches, total, files, timedOut, scanned, candidates } = result;
  const lines = [];

  if (!total) {
    lines.push(`No text matching "${needle}" in ${scanned} indexed file${scanned === 1 ? '' : 's'}.`);
  } else {
    lines.push(`"${needle}": ${total} line${total === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`);
  }

  let file = null;
  let group;
  for (const m of matches) {
    if (m.path !== file) {
      file = m.path;
      group = undefined;
      lines.push(file);
    }
    const key = m.symbol ? m.symbol.qname : null;
    if (key !== group) {
      group = key;
      if (m.symbol) {
        const s = m.symbol;
        const range = s.end_line !== s.start_line ? `${s.start_line}-${s.end_line}` : `${s.start_line}`;
        lines.push(`  in ${s.kind} ${displayName(s)} (${range})`);
      }
    }
    lines.push(`${String(m.line).padStart(6)}  ${m.text}`);
  }

  if (total > matches.length) {
    lines.push(`(+${total - matches.length} more lines not shown; narrow with path, or raise limit)`);
  }
  if (timedOut) {
    lines.push(`(stopped at the time limit after ${scanned} of ${candidates} files; narrow with path to search the rest)`);
  }
  return lines;
}
