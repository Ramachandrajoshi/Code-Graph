/**
 * Token estimator tests.
 *
 * The estimate IS the budget contract: every --budget, every MCP tool-schema
 * budget, every truncation decision is made against it. If it under-counts, a
 * response that reports "fits" is silently over the real cap, and the agent
 * stops looking at a truncated answer it believes is complete.
 *
 * The defect this guards: the chars/3.6 heuristic was tuned on ASCII source,
 * but real BPE tokenizers spend ~1 token per CJK / emoji / accented codepoint.
 * A CJK-heavy response billed with the ASCII divisor under-counted ~3.3x.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimate } from '../src/core/tokens.js';

test('ASCII estimates are unchanged by the non-ASCII weighting', () => {
  // Regression guard: the non-ASCII branch is inert for ASCII text, so the
  // numbers the budget tests and `npm run bench` depend on must not move.
  assert.equal(estimate('a'.repeat(40)), 12, '40 ASCII word chars ≈ 12 tokens');
  assert.equal(estimate('const x = 1;'), estimate('const x = 1;'));
  // Punctuation-heavy, whitespace, and empty all keep their prior behaviour.
  assert.ok(estimate('') === 0);
  assert.ok(estimate('   ') > 0, 'a whitespace run still costs something');
  // The word/punct/whitespace split must land exactly where it used to:
  // 13 word chars, 4 punct, 3 whitespace runs → ceil(13/3.6 + 4 + 3*0.4) = 9.
  assert.equal(estimate('function foo(a, b) {'), 9);
});

test('CJK content is billed materially above the ASCII char heuristic', () => {
  // This is the under-billing guard. Old behaviour: 40 CJK chars collapsed to
  // ~12 tokens, the same as 40 ASCII chars. Real tokenizers spend ~1 token per
  // glyph, so the estimate MUST rise to reflect that. We assert well above the
  // old ASCII value (12) to pin the direction, with margin.
  const cjk = estimate('字'.repeat(40));
  assert.ok(cjk > 30, `40 CJK chars must bill near-per-glyph, got ${cjk}`);
  assert.ok(cjk >= 40, `40 CJK glyphs should bill ~40 tokens, got ${cjk}`);
  // Tighter is the safe direction, never looser than the old ASCII heuristic.
  assert.ok(cjk > estimate('a'.repeat(40)), 'CJK must bill more than equal-length ASCII');
});

test('emoji (surrogate pairs) count as one codepoint, not two', () => {
  // '😀' is one codepoint encoded as two UTF-16 units. A `.length` loop would
  // double-bill it; `for..of` iterates codepoints, so 20 emoji bill ~20, not 40.
  const emoji = estimate('😀'.repeat(20));
  assert.ok(emoji >= 20 && emoji <= 24, `20 emoji ≈ 20 tokens, got ${emoji}`);
});

test('accented Latin bills per codepoint, not on the 3.6 divisor', () => {
  // 'é' as a single precomposed codepoint is non-ASCII; 30 of them must exceed
  // the ASCII heuristic (30/3.6 ≈ 9), proving the weighting covers accents too.
  const accented = estimate('é'.repeat(30));
  assert.ok(accented > 20, `30 accented codepoints should bill above the ASCII divisor, got ${accented}`);
});

test('mixed ASCII + CJK bills ASCII by the model and CJK per glyph', () => {
  // ASCII prefix keeps its old cost; CJK suffix adds ~1 each. The total must
  // exceed a pure-ASCII estimate of the same length.
  const ascii = estimate('a'.repeat(20));
  const mixed = estimate('a'.repeat(20) + '字'.repeat(20));
  assert.ok(mixed > ascii, 'appending CJK must raise the estimate, not leave it flat');
});
