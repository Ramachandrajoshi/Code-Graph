/**
 * Configuration loading.
 *
 * Precedence, lowest to highest: built-in defaults, `.codegraph/config.json`,
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
    '.codegraph/**',
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

  // Embeddings are opt-in and off by default: they cost money and ship code to a
  // third party, which cuts against the point of the tool.
  embeddings: {
    enabled: false,
    provider: null,
    model: null,
    apiKeyEnv: null,
  },

  // Default token budget for a single tool response when the caller doesn't say.
  defaultBudget: 2000,
};

/** Absolute path to the shared, machine-wide cache (grammars, dependency docs). */
export function userCacheDir() {
  if (process.env.CODE_GRAPH_HOME) return path.resolve(process.env.CODE_GRAPH_HOME);
  return path.join(os.homedir(), '.code-graph');
}

/** Absolute path to a project's index directory. */
export function projectDir(root) {
  return path.join(root, '.codegraph');
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

  if (process.env.CODE_GRAPH_OFFLINE === '1') {
    config = deepMerge(config, { deps: { offline: true } });
  }

  const { root: _ignored, ...rest } = overrides;
  config = deepMerge(config, rest);

  return { ...config, root, dir, db: dbPath(root), cacheDir: userCacheDir() };
}

/** Write config back to `.codegraph/config.json`, creating the directory. */
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
