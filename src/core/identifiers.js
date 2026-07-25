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
