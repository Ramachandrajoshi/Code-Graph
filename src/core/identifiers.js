/**
 * Identifier tokenization.
 *
 * Developers search for `login`, but the code says `handleLogin`,
 * `LOGIN_TIMEOUT`, `login_user`, or `HTTPLoginClient`. A word-boundary tokenizer
 * finds none of those. Splitting identifiers into their component words at index
 * time is what closes that gap, and it is the difference between search that
 * feels broken and search that feels obvious.
 */

/**
 * Split an identifier into lowercase component words.
 *
 *   handleLogin      -> ['handle', 'login']
 *   HTTPLoginClient  -> ['http', 'login', 'client']   (acronym boundary)
 *   login_user       -> ['login', 'user']
 *   LOGIN_TIMEOUT    -> ['login', 'timeout']
 *   parseURL2Path    -> ['parse', 'url', '2', 'path']
 */
export function splitIdentifier(name) {
  if (!name) return [];

  const words = [];
  // Separators first, then camel/acronym boundaries inside each run.
  for (const run of name.split(/[^A-Za-z0-9]+/)) {
    if (!run) continue;

    let start = 0;
    for (let i = 1; i <= run.length; i++) {
      if (i === run.length) {
        words.push(run.slice(start, i));
        break;
      }

      const prev = run[i - 1];
      const cur = run[i];
      const next = run[i + 1];

      const lowerToUpper = isLower(prev) && isUpper(cur);
      // `HTTPLogin`: break before the last capital of an acronym run.
      const acronymEnd = isUpper(prev) && isUpper(cur) && next && isLower(next);
      const digitEdge = isDigit(prev) !== isDigit(cur);

      if (lowerToUpper || acronymEnd || digitEdge) {
        words.push(run.slice(start, i));
        start = i;
      }
    }
  }

  return words.filter(Boolean).map((w) => w.toLowerCase());
}

/**
 * The `parts` value stored in FTS5: component words, space-joined.
 * Returns '' when splitting adds nothing over the raw name.
 */
export function identifierParts(name) {
  const words = splitIdentifier(name);
  if (words.length <= 1) return '';
  return words.join(' ');
}

/**
 * Character trigrams for substring search, covering what FTS5 cannot: finding
 * `ogin` inside `handleLogin`, or matching a typo'd fragment.
 */
export function trigrams(name) {
  const s = name.toLowerCase();
  if (s.length < 3) return s ? [s] : [];
  const out = new Set();
  for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3));
  return [...out];
}

function isUpper(c) { return c >= 'A' && c <= 'Z'; }
function isLower(c) { return c >= 'a' && c <= 'z'; }
function isDigit(c) { return c >= '0' && c <= '9'; }

/** Longest body examined for search terms, and the most terms kept per symbol. */
const BODY_SCAN_CHARS = 24000;
const BODY_TERM_CAP = 256;

const WORD = /[A-Za-z_À-￿][A-Za-z0-9_À-￿]{2,}/g;

/**
 * The distinct words a piece of source uses, for full-text indexing.
 *
 * A symbol's name, signature and doc comment say what it is called. What it
 * *does* is in its body — the helpers it calls, the fields it touches, the
 * words in its error messages — and a search that cannot see that sends the
 * agent back to grep the moment it does not already know the name.
 *
 * Every identifier contributes itself and its component words, so a body that
 * calls `retryWithBackoff` is found by "retry", by "backoff", and by the whole
 * name. The set is capped: a few very long functions would otherwise dominate
 * the index, and past a few hundred distinct words more of them stop adding
 * anything a query would distinguish.
 *
 * Deliberately language-blind. Keywords are indexed along with everything
 * else; they appear in nearly every symbol, so the ranker's inverse document
 * frequency discounts them to nothing without a per-language stop list.
 */
export function searchTerms(text) {
  if (!text) return '';
  const source = text.length > BODY_SCAN_CHARS ? text.slice(0, BODY_SCAN_CHARS) : text;
  const seen = new Set();

  WORD.lastIndex = 0;
  let m;
  while ((m = WORD.exec(source)) !== null) {
    const word = m[0];
    if (word.length > 48) continue;   // hashes, base64, minified runs
    const lower = word.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    // Only a compound identifier has parts worth adding.
    if (lower !== word || word.includes('_')) {
      for (const part of splitIdentifier(word)) {
        if (part.length >= 3) seen.add(part);
      }
    }
    if (seen.size >= BODY_TERM_CAP) break;
  }
  return [...seen].join(' ');
}

/**
 * A crude stem: the query word with one common English suffix removed.
 *
 * Used only as a prefix to match against, so it does not have to be a real
 * word — "pars" is what lets "parsing" find `parseConfig` and `Parser`. Never
 * shortens below four characters, where a prefix starts matching everything.
 */
export function stem(word) {
  const w = word.toLowerCase();
  for (const suffix of ['ations', 'ation', 'ings', 'ing', 'ies', 'ers', 'ed', 'es', 'er', 's']) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 4) return w.slice(0, w.length - suffix.length);
  }
  return w;
}
