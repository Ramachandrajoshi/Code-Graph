/**
 * Programmatic API.
 *
 * The CLI and MCP server are the primary interfaces; this exists for the cases
 * they do not cover — embedding code-graph in another tool, scripting a custom
 * report, or building a different agent integration on top of the same index.
 *
 * Language-pack authors want `code-graph/sdk` instead, which is a smaller and
 * more stable surface.
 *
 * @example
 * import { openProject } from 'code-graph';
 *
 * const project = await openProject('/path/to/repo');
 * await project.index();
 *
 * console.log(project.find('handleLogin'));
 * console.log(project.impact('handleLogin'));
 * project.close();
 */

import { loadConfig, saveConfig, isInitialized, userCacheDir } from './core/config.js';
import { Store } from './core/store.js';
import { Indexer } from './core/indexer.js';
import { PackRegistry } from './packs/registry.js';
import { Resolver } from './core/resolve.js';
import { computeRanks } from './core/rank.js';
import { search as searchSymbols, renderHits } from './core/search.js';
import { outlineFile, outlineDir, findSymbol, readSymbol } from './core/retrieve.js';
import * as graph from './core/graph.js';
import { listDependencies, lookupDocs } from './deps/lookup.js';
import { extractAllDocs } from './deps/extract.js';
import { estimate, fitToBudget, SavingsLedger } from './core/tokens.js';

export {
  // Configuration
  loadConfig, saveConfig, isInitialized, userCacheDir,
  // Core building blocks
  Store, Indexer, PackRegistry, Resolver, computeRanks,
  // Retrieval
  outlineFile, outlineDir, findSymbol, readSymbol, renderHits,
  // Dependencies
  listDependencies, lookupDocs, extractAllDocs,
  // Token accounting
  estimate, fitToBudget, SavingsLedger,
  // Graph traversal, namespaced to avoid colliding with a caller's `impact`
  graph,
};

/**
 * Open a project and return a convenience facade over the index.
 *
 * The underlying `store` and `config` are exposed for anything this facade does
 * not cover — it is a shortcut, not a wall.
 *
 * @param {string} root  project directory
 * @param {object} [options]
 * @param {boolean} [options.create]  create the index if absent (default true)
 */
export async function openProject(root, options = {}) {
  const config = loadConfig(root, { root, ...options.config });
  const store = await Store.open(config.db, { create: options.create !== false });

  let registry = null;
  const ensureRegistry = async () => {
    registry ??= await PackRegistry.load(config);
    return registry;
  };

  return {
    root: config.root,
    config,
    store,

    /** Build or refresh the index. Returns indexing statistics. */
    async index({ force = false, progress = null } = {}) {
      const reg = await ensureRegistry();
      return new Indexer({ store, config, registry: reg, progress }).run({ force });
    },

    /** Ranked symbol search. */
    find(query, opts = {}) {
      return searchSymbols(store, query, opts);
    },

    /** Outline a file, a directory, or the whole repo. */
    map(path = '', opts = {}) {
      const file = path ? store.getFileByPath(path) : null;
      return file ? outlineFile(store, file, opts) : outlineDir(store, path, opts);
    },

    /** Source for one symbol, by name or qualified name. */
    read(symbol, opts = {}) {
      const [node] = findSymbol(store, symbol, { limit: 1 });
      if (!node) return null;
      return readSymbol(store, config.root, node, opts);
    },

    /** Direct callers of a symbol. */
    callers(symbol, opts = {}) {
      const [node] = findSymbol(store, symbol, { limit: 1 });
      return node ? graph.callers(store, node.id, opts) : [];
    },

    /** Everything transitively affected by changing a symbol. */
    impact(symbol, opts = {}) {
      const [node] = findSymbol(store, symbol, { limit: 1 });
      return node ? graph.impact(store, node.id, opts) : { nodes: [], truncated: false };
    },

    /** Shortest call path between two symbols, or null. */
    path(from, to, opts = {}) {
      const [a] = findSymbol(store, from, { limit: 1 });
      const [b] = findSymbol(store, to, { limit: 1 });
      if (!a || !b) return null;
      const ids = graph.shortestPath(store, a.id, b.id, opts);
      return ids ? graph.hydrate(store, ids) : null;
    },

    /** Dependencies ranked by how much this project uses them. */
    dependencies(opts = {}) {
      return listDependencies(store, opts);
    },

    /** Index counts and the cumulative savings ledger. */
    stats() {
      return { ...store.stats(), counters: store.counters('total.') };
    },

    close() {
      registry?.dispose();
      store.close();
    },
  };
}
