/**
 * `find`, end to end: one question in, one rendered answer out.
 *
 * Shared by the MCP tool and the CLI command so the two cannot drift, and so
 * the decision about *how* to search lives in one place. There are three ways
 * a query gets answered:
 *
 *   symbols  the default. Names, signatures, docs and function bodies, ranked.
 *   text     the query is quoted ("connection refused"): it is literal text to
 *            look for in the files, reported under the symbols containing it.
 *   fallback an unquoted query that matched no symbol is tried as text before
 *            giving up — an agent that asks for `ECONNRESET` should get the
 *            line that mentions it, not "no symbols matching" and a trip to
 *            grep.
 *
 * The caller never has to pick a mode, which matters more than it sounds: a
 * tool with a mode switch gets called in the wrong mode, and a second tool for
 * text would cost schema tokens on every turn of every conversation.
 */

import { search, renderHits, formatSuggestions } from './search.js';
import { textSearch, renderTextMatches } from './textsearch.js';

/** A query wrapped in matching quotes is literal text. */
function quoted(query) {
  const m = /^(["'`])([\s\S]+)\1$/.exec(query.trim());
  return m ? m[2] : null;
}

/**
 * @param {object} store
 * @param {object} config  needs `root`, to read files for a text search
 * @param {object} args    `{ query, kind, lang, path, limit }`
 * @returns {Promise<{ mode: 'symbols'|'text'|'none', lines: string[], hits: Array }>}
 *   `hits` is the raw symbol hits (empty in text mode), for callers that
 *   render their own format.
 */
export async function find(store, config, args) {
  const query = String(args.query ?? '').trim();
  const filters = { kind: args.kind ?? null, lang: args.lang ?? null, path: args.path ?? null };
  const textOpts = { path: filters.path, lang: filters.lang, limit: args.limit ?? 40 };

  const literal = quoted(query);
  if (literal !== null) {
    const result = await textSearch(store, config.root, literal, textOpts);
    return { mode: result.total ? 'text' : 'none', lines: renderTextMatches(result, literal), hits: [] };
  }

  const hits = search(store, query, { ...filters, limit: args.limit });
  if (hits.length) return { mode: 'symbols', lines: renderHits(hits), hits };

  // A filter that emptied a non-empty candidate set is NOT the same as "no
  // matches exist" (truncate loudly). search() attaches filterNote for that
  // case; surface it verbatim so the agent questions the filter instead of
  // concluding the symbol is absent.
  if (hits.filterNote) return { mode: 'none', lines: [hits.filterNote], hits };

  // Nothing is *named* this. It may still be written somewhere — a string, a
  // comment, a config key, an identifier in a language without queries. A
  // `kind` filter means the caller wanted a symbol specifically, so text
  // would not be an answer to the question asked.
  if (query.length >= 3 && !filters.kind) {
    const result = await textSearch(store, config.root, query, textOpts);
    if (result.total) {
      return {
        mode: 'text',
        lines: [`No symbol named '${query}'; found as text:`, ...renderTextMatches(result, query)],
        hits,
      };
    }
  }

  return { mode: 'none', lines: formatSuggestions(store, query).split('\n'), hits };
}
