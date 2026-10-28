/**
 * Token estimation and the savings ledger.
 *
 * The whole product is judged on tokens, so we need a number everywhere — but we
 * need it to be cheap, because it runs on every node of every file during
 * indexing. A real BPE tokenizer is ~100x slower than what we do here and would
 * dominate index time for no decision-changing gain.
 *
 * The heuristic: source code tokenizes at roughly 3.5-4.0 chars/token across
 * BPE vocabularies, denser than prose because identifiers split. We use a
 * character-class weighting that tracks real tokenizers closely enough for
 * budget enforcement. `bench/` uses an exact tokenizer when measuring claims.
 */

const CHARS_PER_TOKEN = 3.6;

/**
 * Cost of a single non-ASCII codepoint, in tokens.
 *
 * The 3.6 chars/token heuristic is derived from ASCII source code, where many
 * characters combine into one BPE token. Real BPE vocabularies spend roughly
 * ONE token per logographic / emoji / accented codepoint — a CJK glyph is its
 * own token, not a third of one. Measuring a CJK-heavy response with the ASCII
 * divisor under-bills it by ~3.3x, and since the estimate IS the budget
 * contract ("tokens are the product"), budgets that looked satisfied were over
 * the real cap for non-English codebases.
 *
 * 1.0 is a deliberately conservative constant (not a tuned per-script table):
 * it only ever RAISES an estimate relative to the old heuristic — the safe
 * direction, since over-counting just truncates a touch early, while
 * under-counting silently overruns the real cap. ASCII content is unaffected
 * (non-ASCII count is 0), so existing ASCII budget/bench numbers do not move.
 */
const NON_ASCII_TOKEN_WEIGHT = 1.0;

/**
 * Estimate tokens for a string of source code.
 *
 * Whitespace runs collapse to roughly one token regardless of length, and
 * punctuation tends to be one token each, so a flat chars/N understates
 * heavily-punctuated code and overstates deeply-indented code. Correcting for
 * both keeps the estimate within ~10% on typical source.
 *
 * Iterates by CODEPOINT (`for..of`), not `.length`, so a surrogate-pair emoji
 * counts as one codepoint (and one token) rather than two.
 */
export function estimate(text) {
  if (!text) return 0;

  let punct = 0;
  let whitespaceRuns = 0;
  let wordChars = 0;
  let nonAscii = 0;
  let inWhitespace = false;

  for (const ch of text) {
    const c = ch.codePointAt(0);

    // Non-ASCII (codepoint > 127): CJK, emoji, accents, wide forms. Billed at
    // ~1 token each, NOT folded into the chars/3.6 word model.
    if (c > 127) {
      nonAscii++;
      inWhitespace = false;
      continue;
    }

    const isWs = c === 32 || c === 9 || c === 10 || c === 13;
    if (isWs) {
      if (!inWhitespace) {
        whitespaceRuns++;
        inWhitespace = true;
      }
      continue;
    }
    inWhitespace = false;

    // ASCII punctuation ranges, excluding alphanumerics and underscore.
    const isPunct =
      (c >= 33 && c <= 47) ||
      (c >= 58 && c <= 64) ||
      (c >= 91 && c <= 96 && c !== 95) ||
      (c >= 123 && c <= 126);
    if (isPunct) punct++;
    else wordChars++;
  }

  // Word-ish content splits at ~3.6 chars/token; punctuation is ~1 token each;
  // each whitespace run costs about one token no matter how long it is; and each
  // non-ASCII codepoint costs ~NON_ASCII_TOKEN_WEIGHT token.
  return Math.max(
    1,
    Math.ceil(
      wordChars / CHARS_PER_TOKEN + punct + whitespaceRuns * 0.4 + nonAscii * NON_ASCII_TOKEN_WEIGHT
    )
  );
}

/** Estimate tokens for a file we have already read. */
export function estimateFile(content) {
  return estimate(content);
}

/**
 * Trim a list of already-rendered lines to fit a token budget.
 *
 * Returns the kept lines plus a count of what was dropped, so the caller can
 * tell the agent explicitly that truncation happened. Silently truncating is
 * worse than not truncating — the agent would treat a partial answer as
 * complete and stop looking.
 */
export function fitToBudget(lines, budget) {
  // null/undefined means "no limit". ANY number is a real limit, including 0 and
  // negatives — those arise when a caller subtracts a header cost and the budget
  // is already spent. Folding zero in with "no limit" is how a tight budget ends
  // up returning the entire body, the exact opposite of what was asked.
  if (budget === null || budget === undefined) {
    return { lines, dropped: 0, tokens: sumTokens(lines) };
  }
  if (budget <= 0) return { lines: [], dropped: lines.length, tokens: 0 };

  const kept = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = estimate(lines[i]) + 1; // +1 for the newline
    if (total + cost > budget) {
      return { lines: kept, dropped: lines.length - i, tokens: total };
    }
    kept.push(lines[i]);
    total += cost;
  }
  return { lines: kept, dropped: 0, tokens: total };
}

function sumTokens(lines) {
  let t = 0;
  for (const l of lines) t += estimate(l) + 1;
  return t;
}

/**
 * Usage ledger: how many tokens responses actually cost.
 *
 * Records only measured quantities. An earlier version also recorded a
 * "baseline" — what a grep-and-read workflow would supposedly have spent — and
 * reported the ratio as tokens saved. That number was not defensible: it
 * required assuming how many files another agent would have opened and how much
 * of each it would have read, and every plausible assumption produced a
 * different, conveniently flattering result.
 *
 * `source` is recorded only where a concrete comparable artifact exists: the
 * file an outline describes, or the file a symbol was read from. That is a fact
 * about two things that both exist, not a claim about a road not taken.
 */
export class UsageLedger {
  constructor(store) {
    this.store = store;
  }

  /**
   * @param {string} tool
   * @param {number} returned  tokens in the response
   * @param {number} [source]  tokens in the file this response came from, when
   *                           there is exactly one such file. Omit otherwise.
   */
  record(tool, returned, source = 0) {
    this.store?.bumpCounters({
      [`tool.${tool}.calls`]: 1,
      [`tool.${tool}.tokens_returned`]: returned,
      [`tool.${tool}.tokens_source`]: source,
      'total.tokens_returned': returned,
      'total.tokens_source': source,
    });
    return { returned, source };
  }
}
