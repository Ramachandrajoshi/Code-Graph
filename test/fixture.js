/**
 * End-to-end fixture harness.
 *
 * Builds a real repo on disk, runs the real indexer over it, and hands back an
 * open store. Resolution bugs live in the interaction between the walker,
 * packs, extractor and resolver — mocking any layer hides exactly the class of
 * bug these tests exist to catch.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/core/store.js';
import { Indexer } from '../src/core/indexer.js';
import { PackRegistry } from '../src/packs/registry.js';
import { DEFAULTS } from '../src/core/config.js';

export async function buildFixture(files, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-fx-'));

  // Redirect the machine-wide cache into the fixture. Tests must never read or
  // write the developer's real ~/.code-graph — doing so both pollutes their
  // machine and lets one test's cached data leak into another's assertions.
  // Grammars are still found via the bundled tree-sitter-wasms package.
  const priorHome = process.env.CODE_GRAPH_HOME;
  process.env.CODE_GRAPH_HOME = path.join(root, '.cache');

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const config = {
    ...DEFAULTS,
    ...overrides,
    root,
    dir: path.join(root, '.codegraph'),
    db: path.join(root, '.codegraph', 'index.db'),
    deps: { ...DEFAULTS.deps, offline: true },
  };

  const store = await Store.open(config.db);
  const registry = await PackRegistry.load(config);
  const indexer = new Indexer({ store, config, registry });
  const stats = await indexer.run({});

  return {
    root,
    store,
    registry,
    stats,

    /** Look up a node by name; fails loudly rather than returning undefined. */
    node(name) {
      const row = store.get(
        `SELECT n.*, f.path FROM nodes n JOIN files f ON f.id = n.file_id
          WHERE n.name = ? ORDER BY n.rank DESC LIMIT 1`,
        name
      );
      if (!row) throw new Error(`fixture: no node named '${name}'`);
      return row;
    },

    /** Outgoing edges from a named symbol, with target names resolved. */
    edgesFrom(name) {
      const src = this.node(name);
      return store.all(
        `SELECT e.kind, e.confidence, e.line,
                n.name AS dst_name, f.path AS dst_path,
                x.package AS ext_package, x.symbol AS ext_symbol, x.ecosystem
           FROM edges e
           LEFT JOIN nodes n ON n.id = e.dst_id
           LEFT JOIN files f ON f.id = n.file_id
           LEFT JOIN externals x ON x.id = e.ext_id
          WHERE e.src_id = ? ORDER BY e.line`,
        src.id
      );
    },

    /** The single edge from `fromName` to `toName`, or undefined. */
    edge(fromName, toName) {
      return this.edgesFrom(fromName).find((e) => e.dst_name === toName);
    },

    importOf(filePath, spec) {
      return store.get(
        `SELECT i.*, rf.path AS resolved_path, x.package AS ext_package, x.ecosystem
           FROM imports i
           JOIN files f ON f.id = i.file_id
           LEFT JOIN files rf ON rf.id = i.resolved_file_id
           LEFT JOIN externals x ON x.id = i.external_id
          WHERE f.path = ? AND i.spec = ? LIMIT 1`,
        filePath, spec
      );
    },

    cleanup() {
      store.close();
      registry.dispose();
      if (priorHome === undefined) delete process.env.CODE_GRAPH_HOME;
      else process.env.CODE_GRAPH_HOME = priorHome;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Skip the whole suite when grammars are unavailable (no network, no bundle). */
export function grammarsAvailable() {
  try {
    // eslint-disable-next-line no-undef
    require('node:module').createRequire(import.meta.url).resolve('tree-sitter-wasms/package.json');
    return true;
  } catch {
    return false;
  }
}
