/**
 * Configuration loading.
 *
 * Precedence, lowest to highest: built-in defaults, `.cgraph/config.json`,
 * environment variables, explicit CLI flags. Everything is optional — the tool
 * must work with zero configuration in a repo it has never seen.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findProjectRoot } from './paths.js';

export const DEFAULTS = {
  // Files bigger than this are indexed as a stub (path + size) but never parsed.
  // Generated bundles and vendored blobs are the usual offenders and they poison
  // both index time and search relevance.
  maxFileBytes: 1024 * 1024,

  // A file whose mean line length exceeds this is almost certainly minified or
  // generated. Parsing it produces thousands of useless nodes.
  maxMeanLineLength: 500,

  // Extra ignore globs on top of .gitignore, applied to every project.
  ignore: [
    '.cgraph/**',
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/vendor/**',
    '**/.venv/**',
    '**/venv/**',
    '**/__pycache__/**',
    '**/target/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/poetry.lock',
    '**/Cargo.lock',
    '**/go.sum',
  ],

  // Parser worker count. 0 means "cpus - 1, at least 1".
  workers: 0,

  // Language packs explicitly enabled/disabled. Empty `enable` means autodetect.
  packs: { enable: [], disable: [] },

  // Dependency documentation.
  deps: {
    enabled: true,
    offline: false,
    maxPackages: 200,
  },

  // Embeddings are opt-in and off by default: a hosted provider costs money and
  // ships your code to a third party, which cuts against the point of the tool.
  // A local model avoids both, which is why `provider: "local"` exists.
  //
  //   { "embeddings": {
  //       "enabled": true,
  //       "provider": "local",
  //       "baseUrl": "http://localhost:11434/v1",   // Ollama; LM Studio is :1234/v1
  //       "model": "nomic-embed-text",
  //       "dimensions": 768                          // optional; verified on first batch
  //   }}
  //
  // dimensions is optional. Set it and cgraph checks the server actually
  // returns that width — a mismatch silently corrupts every similarity score,
  // and the symptom (subtly wrong rankings) is near-impossible to trace back.
  embeddings: {
    enabled: false,
    provider: null,     // 'local' | 'openai' | 'voyage'
    baseUrl: null,      // required for 'local'
    model: null,        // required for 'local'; hosted providers have defaults
    dimensions: null,
    apiKeyEnv: null,    // env var holding the key; never the key itself
  },

  // Default token budget for a single tool response when the caller doesn't say.
  defaultBudget: 2000,

  // Keep the index current without anyone remembering to.
  //
  // The MCP server checks for changes before answering, so an agent never reads
  // a stale graph. The check is a stat of each file, not a read (~170ms on a
  // 3,000-file repo), and is throttled so a burst of tool calls costs one scan.
  //
  // This is the default because staleness is the failure mode that matters
  // most: an agent acting on a moved line number edits the wrong code, and
  // nothing in the output would tell it that happened.
  autoRefresh: {
    enabled: true,
    throttleMs: 3000,
  },
};

/** Absolute path to the shared, machine-wide cache (grammars, dependency docs). */
export function userCacheDir() {
  if (process.env.CGRAPH_HOME) return path.resolve(process.env.CGRAPH_HOME);
  return path.join(os.homedir(), '.cgraph');
}

/** Absolute path to a project's index directory. */
export function projectDir(root) {
  return path.join(root, '.cgraph');
}

/** Absolute path to a project's SQLite index. */
export function dbPath(root) {
  return path.join(projectDir(root), 'index.db');
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * Load configuration for the project containing `cwd`.
 * Returns `{ root, dir, db, ...settings }`.
 */
export function loadConfig(cwd = process.cwd(), overrides = {}) {
  const root = overrides.root ? path.resolve(overrides.root) : findProjectRoot(cwd);
  const dir = projectDir(root);
  const file = path.join(dir, 'config.json');

  let fileConfig = {};
  if (fs.existsSync(file)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid ${file}: ${err.message}`);
    }
  }

  let config = deepMerge(DEFAULTS, fileConfig);

  if (process.env.CGRAPH_OFFLINE === '1') {
    config = deepMerge(config, { deps: { offline: true } });
  }

  const { root: _ignored, ...rest } = overrides;
  config = deepMerge(config, rest);

  return { ...config, root, dir, db: dbPath(root), cacheDir: userCacheDir() };
}

/** Write config back to `.cgraph/config.json`, creating the directory. */
export function saveConfig(root, settings) {
  const dir = projectDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  // Persist only what differs from defaults, so upgrades pick up new defaults.
  const diff = diffFromDefaults(DEFAULTS, settings);
  fs.writeFileSync(file, JSON.stringify(diff, null, 2) + '\n');
  return file;
}

function diffFromDefaults(base, current) {
  const out = {};
  for (const [k, v] of Object.entries(current)) {
    if (!(k in base)) continue;
    const b = base[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object') {
      const sub = diffFromDefaults(b, v);
      if (Object.keys(sub).length) out[k] = sub;
    } else if (JSON.stringify(v) !== JSON.stringify(b)) {
      out[k] = v;
    }
  }
  return out;
}

/** True when the project has been initialized. */
export function isInitialized(root) {
  return fs.existsSync(dbPath(root));
}
