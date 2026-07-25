/**
 * Public SDK for language-pack authors.
 *
 * A pack is a plain object with optional hooks — there is no base class to
 * extend and no framework to learn. This module exports the few helpers a pack
 * needs so authors do not have to reach into core internals, which would make
 * every pack break on refactors.
 *
 * Import as:
 *   import { definePack, tryCandidates, normalizeRelative } from 'code-graph/sdk';
 *
 * A minimal working pack:
 *
 *   export default definePack({
 *     id: 'mylang',
 *     languages: ['mylang'],
 *     queries: { tags: new URL('queries/tags.scm', import.meta.url).pathname },
 *   });
 *
 * That alone yields outlines, definitions and heuristic call edges. Each
 * additional hook buys precision:
 *
 *   signature()     exact declarations instead of the first physical line
 *   docComment()    documentation attached to symbols
 *   resolveImport() turns INFERRED edges into EXACT ones — the biggest win
 *   builtins        keeps runtime calls out of the unresolved list
 */

export { tryCandidates, normalizeRelative, EXACT, INFERRED } from '../core/resolve.js';
export { splitIdentifier, identifierParts, trigrams } from '../core/identifiers.js';
export { estimate } from '../core/tokens.js';

/** Capture names the extractor understands. Packs may invent new suffixes. */
export const CAPTURES = {
  definition: [
    'definition.class', 'definition.interface', 'definition.function',
    'definition.method', 'definition.field', 'definition.var',
    'definition.const', 'definition.type', 'definition.enum', 'definition.module',
  ],
  reference: [
    'reference.call', 'reference.instantiates', 'reference.extends',
    'reference.implements', 'reference.type', 'reference.decorates',
  ],
  auxiliary: ['name', 'receiver', 'source', 'symbol', 'alias'],
};

/**
 * Validate a pack definition and return it unchanged.
 *
 * Wrapping a pack in this is optional but catches the mistakes that are
 * otherwise diagnosed as a confusing runtime failure deep inside extraction —
 * a missing id, a queries map pointing at nothing, a hook that is not callable.
 */
export function definePack(pack) {
  const problems = validatePack(pack);
  if (problems.length) {
    throw new Error(`Invalid language pack:\n  ${problems.join('\n  ')}`);
  }
  return pack;
}

/**
 * Check a pack definition. Returns an array of human-readable problems, empty
 * when the pack is well formed. Used by `definePack` and by `cgraph packs list`.
 */
export function validatePack(pack) {
  const problems = [];

  if (!pack || typeof pack !== 'object') return ['pack must be an object'];
  if (!pack.id || typeof pack.id !== 'string') problems.push('missing `id` (a short string)');

  const languages = pack.languages ?? (pack.id ? [pack.id] : []);
  if (!Array.isArray(languages) || !languages.length) {
    problems.push('`languages` must be a non-empty array of language ids');
  }

  if (!pack.queries || typeof pack.queries !== 'object') {
    problems.push('`queries` must be an object, e.g. { tags: "/abs/path/tags.scm" }');
  } else if (!pack.queries.tags) {
    problems.push('`queries.tags` is required — without it the pack extracts no symbols');
  }

  for (const hook of ['detect', 'signature', 'docComment', 'isExported', 'visibility',
                      'resolveImport', 'parseImport', 'moduleDoc']) {
    if (pack[hook] !== undefined && typeof pack[hook] !== 'function') {
      problems.push(`\`${hook}\` must be a function if present`);
    }
  }

  if (pack.builtins) {
    const b = pack.builtins;
    const setLike = (v) => v && typeof v.has === 'function';
    if (b.globals !== undefined && !setLike(b.globals)) {
      problems.push('`builtins.globals` must be a Set');
    }
    if (b.methods !== undefined && !setLike(b.methods)) {
      problems.push('`builtins.methods` must be a Set');
    }
  }

  return problems;
}

/**
 * Build a `ctx` object of the shape packs receive in `detect` and
 * `resolveImport`. Exported so pack authors can unit-test their hooks without
 * standing up an index.
 */
export function makeTestContext({ root = '/repo', files = [] } = {}) {
  const set = new Set(files);
  return {
    root,
    hasFile: (p) => set.has(p),
    fileFor: (p) => (set.has(p) ? { path: p } : null),
    allPaths: () => set.values(),
  };
}
