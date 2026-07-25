/**
 * Tree-sitter host.
 *
 * The one place that touches `web-tree-sitter`. Everything else in the codebase
 * speaks in captures and plain objects, so a breaking change in the 0.2x line
 * costs us this file and nothing else.
 *
 * Languages and compiled queries are cached: compiling a query is far more
 * expensive than running it, and the same handful of queries run against every
 * file in the repo.
 */

import { Parser, Language, Query } from 'web-tree-sitter';
import { resolveGrammar } from './grammars.js';

let initPromise = null;

/** Initialize the wasm runtime once per process. */
async function ensureInit() {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

export class ParserHost {
  constructor({ offline = false, onDownload = null } = {}) {
    this.offline = offline;
    this.onDownload = onDownload;
    this.languages = new Map();  // grammar name -> Language
    this.queries = new Map();    // `${grammar}::${key}` -> Query
    this.parser = null;
  }

  async init() {
    await ensureInit();
    if (!this.parser) this.parser = new Parser();
    return this;
  }

  /** Load (and cache) a grammar by name or absolute .wasm path. */
  async language(name, explicitPath = null) {
    if (this.languages.has(name)) return this.languages.get(name);
    await this.init();

    const file = explicitPath
      ?? (await resolveGrammar(name, { offline: this.offline, onDownload: this.onDownload })).path;

    const lang = await Language.load(file);
    this.languages.set(name, lang);
    return lang;
  }

  /**
   * Compile and cache a query.
   *
   * A malformed .scm is a pack-authoring error, and tree-sitter's native message
   * ("Query error at 12:3") gives no hint which pack or file is at fault. Since
   * third-party packs are a first-class feature, the error must name the source.
   */
  async query(grammarName, key, source, { origin = 'unknown' } = {}) {
    const cacheKey = `${grammarName}::${key}`;
    if (this.queries.has(cacheKey)) return this.queries.get(cacheKey);

    const lang = await this.language(grammarName);
    let q;
    try {
      q = new Query(lang, source);
    } catch (err) {
      throw new Error(
        `Invalid tree-sitter query '${key}' in pack '${origin}' (grammar: ${grammarName}):\n` +
          `  ${err.message}`
      );
    }
    this.queries.set(cacheKey, q);
    return q;
  }

  /**
   * Parse source and run a query, returning plain capture records.
   *
   * Tree-sitter `Node` objects hold references into wasm memory that become
   * invalid once the tree is deleted, so everything a caller needs is copied out
   * here. Leaking live nodes to the extractor caused use-after-free crashes that
   * only appeared on large repos.
   */
  async run(grammarName, source, queries) {
    const lang = await this.language(grammarName);
    await this.init();
    this.parser.setLanguage(lang);

    let tree;
    try {
      tree = this.parser.parse(source);
    } catch (err) {
      throw new Error(`Parse failed: ${err.message}`);
    }
    if (!tree) throw new Error('Parse returned no tree');

    try {
      const out = {};
      for (const [key, q] of Object.entries(queries)) {
        out[key] = collect(q, tree.rootNode);
      }
      out.hasError = tree.rootNode.hasError;
      return out;
    } finally {
      // Freeing the tree is mandatory: wasm memory is not garbage collected by
      // JS, and an unreleased tree per file exhausts the heap on a large repo.
      tree.delete();
    }
  }

  dispose() {
    for (const q of this.queries.values()) q.delete?.();
    this.queries.clear();
    this.parser?.delete?.();
    this.parser = null;
  }
}

/**
 * Flatten query matches into `{ pattern, captures: [{ name, text, ... }] }`.
 * Text and positions are copied eagerly — see the note in `run`.
 */
function collect(query, root) {
  const matches = query.matches(root);
  const out = [];

  for (const match of matches) {
    const captures = [];
    for (const c of match.captures) {
      const n = c.node;
      captures.push({
        name: c.name,
        text: n.text,
        type: n.type,
        startByte: n.startIndex,
        endByte: n.endIndex,
        startLine: n.startPosition.row + 1,   // 1-based: humans and editors agree
        endLine: n.endPosition.row + 1,
        startCol: n.startPosition.column,
      });
    }
    out.push({ pattern: match.patternIndex, captures });
  }

  return out;
}
