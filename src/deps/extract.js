/**
 * Dependency API extraction.
 *
 * Local-first, deliberately. The documentation is usually already on disk and
 * better than anything downloadable: `node_modules/<pkg>` ships the real `.d.ts`
 * for the exact version installed, while a registry fetch gives whatever is
 * latest and may not match. Network is a fallback, not the primary path.
 *
 * Because dependency sources are parsed with the same tree-sitter pipeline as
 * project code, every language pack gets this for free once it declares a
 * `deps` adapter.
 *
 * The cache is machine-wide (`~/.cgraph/docs/<eco>/<pkg>@<ver>/`), so ten
 * repos using express@4 extract it once.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { userCacheDir } from '../core/config.js';
import { ParserHost } from '../core/parser-host.js';
import { extract } from '../core/extract.js';

/**
 * Extract API surface for every dependency this project actually uses.
 *
 * Driven by `externals` — the packages the graph proved are imported — rather
 * than by the manifest, so a dependency listed in package.json but never
 * imported costs nothing.
 */
export async function extractAllDocs(store, config, { offline = false, onProgress = null } = {}) {
  const packages = store.all(
    `SELECT package, ecosystem, COUNT(*) AS symbols, SUM(use_count) AS uses
       FROM externals
      WHERE ecosystem NOT IN ('builtin')
      GROUP BY package, ecosystem
      ORDER BY uses DESC
      LIMIT ?`,
    config.deps?.maxPackages ?? 200
  );

  const host = new ParserHost({ offline });
  const result = { packages: 0, symbols: 0, failed: 0, fromCache: 0 };

  try {
    for (const pkg of packages) {
      onProgress?.(pkg.package);
      try {
        const api = await resolvePackageApi(pkg, config, host, { offline });
        if (!api) { result.failed++; continue; }

        if (api.cached) result.fromCache++;
        result.packages++;
        result.symbols += storeApi(store, pkg, api);
      } catch {
        // One unreadable dependency must not abort the rest.
        result.failed++;
      }
    }
  } finally {
    host.dispose();
  }

  store.setMeta('deps_extracted_at', Date.now());
  return result;
}

/**
 * Cached API, local extraction, or registry fetch — in that order.
 *
 * The cache is keyed on the CONTENT of the type entry, not just on
 * package@version. Version alone looks sufficient because published packages are
 * immutable, but locally it is wrong in ways that produce silently stale docs:
 * `npm link`, workspace packages, patch-package, and any pre-publish build all
 * change the bytes while keeping the version. Hashing the source makes a
 * changed dependency a cache miss, and still lets ten projects sharing an
 * identical express@4 extract it once.
 */
async function resolvePackageApi(pkg, config, host, { offline }) {
  const located = locate(pkg, config);
  const version = located?.version ?? null;
  const fingerprint = located ? sourceFingerprint(located) : null;

  const cached = readCache(pkg.ecosystem, pkg.package, version, fingerprint);
  if (cached) return { ...cached, cached: true };

  let api = null;
  if (located) api = await extractLocal(located, pkg, host);
  if (!api && !offline) api = await fetchRegistry(pkg);

  if (api) writeCache(pkg.ecosystem, pkg.package, version ?? api.version, fingerprint, api);
  return api;
}

/** Short hash of the file the API will be read from. */
function sourceFingerprint(located) {
  const file = located.kind === 'npm'
    ? findTypeEntry(located.dir, located.manifest)
    : (located.file ?? ['__init__.pyi', '__init__.py']
        .map((f) => path.join(located.dir, f)).find(fs.existsSync));

  if (!file) return null;
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- local

/**
 * Find a package on disk.
 *
 * node_modules is searched upward from the project root because monorepos hoist
 * dependencies to the workspace root, where a naive single-directory lookup
 * finds nothing.
 */
function locate(pkg, config) {
  if (pkg.ecosystem === 'npm' || pkg.ecosystem === 'node') {
    let dir = config.root;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'node_modules', ...pkg.package.split('/'));
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        const manifest = readJson(path.join(candidate, 'package.json')) ?? {};
        return { kind: 'npm', dir: candidate, manifest, version: manifest.version ?? null };
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  if (pkg.ecosystem === 'pypi') {
    for (const base of pythonSitePackages(config)) {
      const candidate = path.join(base, pkg.package);
      if (fs.existsSync(candidate)) return { kind: 'python', dir: candidate, version: null };
      const single = path.join(base, `${pkg.package}.py`);
      if (fs.existsSync(single)) return { kind: 'python', file: single, version: null };
    }
    return null;
  }

  return null;
}

function pythonSitePackages(config) {
  const roots = [];
  for (const venv of ['.venv', 'venv', 'env']) {
    const base = path.join(config.root, venv);
    // Layout differs by platform: Lib/site-packages on Windows, lib/pythonX.Y
    // elsewhere. Both are probed rather than guessing from process.platform,
    // because a WSL venv inside a Windows checkout is common.
    const win = path.join(base, 'Lib', 'site-packages');
    if (fs.existsSync(win)) roots.push(win);
    const nix = path.join(base, 'lib');
    if (fs.existsSync(nix)) {
      for (const entry of safeReaddir(nix)) {
        const sp = path.join(nix, entry, 'site-packages');
        if (fs.existsSync(sp)) roots.push(sp);
      }
    }
  }
  return roots;
}

async function extractLocal(located, pkg, host) {
  if (located.kind === 'npm') return extractNpm(located, host);
  if (located.kind === 'python') return extractPython(located, host);
  return null;
}

/**
 * Read a package's TypeScript declarations.
 *
 * `.d.ts` is the ideal source: it is the API surface with no implementation, so
 * it is small, complete, and already stripped of the noise we would otherwise
 * have to filter out.
 */
async function extractNpm(located, host) {
  const { dir, manifest } = located;
  const entry = findTypeEntry(dir, manifest);
  if (!entry) return null;

  const source = readFileSafe(entry);
  if (!source) return null;

  const symbols = await parseSymbols(host, 'typescript', source, entry);
  if (!symbols.length) return null;

  return {
    version: manifest.version ?? null,
    source: 'local',
    description: manifest.description ?? null,
    symbols,
  };
}

/** Follow `types`, `typings`, or the `exports` map to a .d.ts. */
function findTypeEntry(dir, manifest) {
  const candidates = [manifest.types, manifest.typings];

  const exp = manifest.exports;
  if (exp && typeof exp === 'object') {
    const root = exp['.'] ?? exp;
    if (typeof root === 'object') {
      for (const key of ['types', 'import', 'require', 'default']) {
        const value = root[key];
        if (typeof value === 'string') candidates.push(value);
        else if (value && typeof value === 'object' && typeof value.types === 'string') {
          candidates.push(value.types);
        }
      }
    }
  }

  candidates.push('index.d.ts', 'dist/index.d.ts', 'lib/index.d.ts', 'types/index.d.ts');

  for (const c of candidates) {
    if (!c || typeof c !== 'string') continue;
    const file = path.join(dir, c.replace(/^\.\//, ''));
    if (file.endsWith('.d.ts') && fs.existsSync(file)) return file;
    // A JS entry frequently has a sibling declaration file.
    const asDts = file.replace(/\.(m|c)?js$/, '.d.ts');
    if (asDts !== file && fs.existsSync(asDts)) return asDts;
  }
  return null;
}

/** Prefer `.pyi` stubs; fall back to the package's own `__init__.py`. */
async function extractPython(located, host) {
  const file = located.file
    ?? ['__init__.pyi', '__init__.py'].map((f) => path.join(located.dir, f)).find(fs.existsSync);
  if (!file) return null;

  const source = readFileSafe(file);
  if (!source) return null;

  const symbols = await parseSymbols(host, 'python', source, file);
  if (!symbols.length) return null;
  return { version: located.version, source: 'local', symbols };
}

/**
 * Parse a dependency file into public symbols.
 *
 * Reuses the project's own extraction pipeline, which is why adding a language
 * pack gets dependency docs for free.
 */
async function parseSymbols(host, langId, source, file) {
  const { PackRegistry } = await import('../packs/registry.js');
  const packModule = await import(`../packs/${langId === 'python' ? 'python' : 'typescript'}/index.js`);
  const pack = packModule.default;

  const compiled = {};
  for (const [key, queryFile] of Object.entries(pack.queries)) {
    const text = readFileSafe(queryFile);
    if (text) compiled[key] = await host.query(langId, `deps:${langId}:${key}`, text, { origin: 'deps' });
  }
  if (!compiled.tags) return [];

  const captures = await host.run(langId, source, compiled);
  const { nodes } = extract({ path: file, source, captures, pack });

  return nodes
    .filter((n) => n.kind !== 'module' && n.depth === 1)   // top-level API only
    .filter((n) => !n.name.startsWith('_'))                 // conventionally private
    .map((n) => ({
      symbol: n.name,
      kind: n.kind,
      signature: n.signature,
      doc: n.doc,
    }));
}

// ---------------------------------------------------------------- registry

/**
 * Registry fallback for packages not installed locally.
 *
 * Deliberately shallow: it fetches metadata and the type entry, nothing more.
 * Downloading and unpacking whole tarballs to index a dependency would cost far
 * more than the tokens it saves.
 */
async function fetchRegistry(pkg) {
  if (pkg.ecosystem === 'npm') return fetchNpm(pkg.package);
  if (pkg.ecosystem === 'pypi') return fetchPypi(pkg.package);
  return null;
}

async function fetchNpm(name) {
  const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`);
  if (!meta) return null;

  const version = meta['dist-tags']?.latest;
  const info = version ? meta.versions?.[version] : null;

  return {
    version: version ?? null,
    source: 'registry',
    description: info?.description ?? meta.description ?? null,
    // Signatures are not fetched: they would require downloading the tarball.
    // Recording the package with its description still improves `docs` output
    // over nothing, and marks it as known-but-undocumented.
    symbols: [],
  };
}

async function fetchPypi(name) {
  const meta = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  if (!meta) return null;
  return {
    version: meta.info?.version ?? null,
    source: 'registry',
    description: meta.info?.summary ?? null,
    symbols: [],
  };
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // Offline, rate-limited, or DNS failure. Dependency docs are an enhancement,
    // never a reason to fail an index.
    return null;
  }
}

// ---------------------------------------------------------------- cache

function cacheFile(ecosystem, pkg, version, fingerprint) {
  const safe = pkg.replace(/[/\\]/g, '__');
  const suffix = fingerprint ? `-${fingerprint}` : '';
  return path.join(userCacheDir(), 'docs', ecosystem, `${safe}@${version ?? 'unknown'}${suffix}.json`);
}

function readCache(ecosystem, pkg, version, fingerprint) {
  // Without either a version or a content fingerprint there is nothing to
  // identify the entry by, and reusing it would be a guess.
  if (!version && !fingerprint) return null;
  const data = readJson(cacheFile(ecosystem, pkg, version, fingerprint));
  return data && Array.isArray(data.symbols) ? data : null;
}

function writeCache(ecosystem, pkg, version, fingerprint, api) {
  try {
    const file = cacheFile(ecosystem, pkg, version, fingerprint);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(api));
  } catch {
    // A read-only or full home directory should not break extraction.
  }
}

// ---------------------------------------------------------------- store

/**
 * Merge extracted signatures into `externals`.
 *
 * Rows created earlier by the resolver already carry `use_count`, which is the
 * whole point — so this updates in place rather than replacing, and never
 * resets a usage count.
 */
function storeApi(store, pkg, api) {
  let written = 0;

  store.transaction(() => {
    store.run(
      `UPDATE externals SET version = COALESCE(?, version), source = ?
        WHERE ecosystem = ? AND package = ?`,
      api.version, api.source, pkg.ecosystem, pkg.package
    );

    const update = store.stmt(
      `UPDATE externals SET signature = ?, doc = ?, kind = ?
        WHERE ecosystem = ? AND package = ? AND symbol = ?`
    );
    const insert = store.stmt(
      `INSERT OR IGNORE INTO externals(ecosystem, package, version, symbol, kind, signature, doc, source, use_count)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0)`
    );

    for (const s of api.symbols) {
      insert.run(pkg.ecosystem, pkg.package, api.version, s.symbol, s.kind, s.signature, s.doc, api.source);
      update.run(s.signature, s.doc, s.kind, pkg.ecosystem, pkg.package, s.symbol);
      written++;
    }
  });

  return written;
}

// ---------------------------------------------------------------- io helpers

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readFileSafe(file) {
  try {
    const stat = fs.statSync(file);
    // A 5 MB bundled .d.ts (looking at you, aws-sdk) yields thousands of
    // symbols nobody asked for and dominates extraction time.
    if (stat.size > 2 * 1024 * 1024) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}
