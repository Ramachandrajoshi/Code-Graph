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
import os from 'node:os';
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
export async function extractAllDocs(store, config, { offline = false, onProgress = null, withGuides = false } = {}) {
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
        const api = await resolvePackageApi(pkg, config, host, { offline, withGuides });
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
async function resolvePackageApi(pkg, config, host, { offline, withGuides = false }) {
  const located = locate(pkg, config);
  const version = located?.version ?? null;
  const fingerprint = located ? sourceFingerprint(located) : null;

  const cached = readCache(pkg.ecosystem, pkg.package, version, fingerprint);
  if (cached) return { ...cached, cached: true };

  let api = null;
  if (located) api = await extractLocal(located, pkg, host);
  if (!api && !offline) api = await fetchRegistry(pkg, host);

  // Prose guidance, where the project publishes it. Separate from the API
  // surface because it comes from a different place and answers a different
  // question — "how do I use this" rather than "what does it expose".
  if (api && withGuides && !offline) {
    const guide = await fetchGuide(pkg, config).catch(() => null);
    if (guide) { api.guide = guide.text; api.guideUrl = guide.url; }
  }

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

  if (pkg.ecosystem === 'nuget' || pkg.ecosystem === 'dotnet') return locateNuget(pkg);

  return null;
}

/**
 * Find a NuGet package in the global package cache.
 *
 * NuGet ships compiled assemblies, not source, so there is no code to parse.
 * What it does ship — when the author enabled documentation generation, which
 * Microsoft's own packages always do — is an XML documentation file beside the
 * DLL. That file contains every public member with its summary text, which is
 * exactly the API surface `docs` wants and far cleaner than decompiled source.
 */
function locateNuget(pkg) {
  const roots = [
    process.env.NUGET_PACKAGES,
    path.join(os.homedir(), '.nuget', 'packages'),
  ].filter(Boolean);

  // Package directories are lower-cased in the cache.
  const name = pkg.package.toLowerCase();

  for (const root of roots) {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) continue;

    // Highest version present. Without a lockfile to consult this is a guess,
    // but a package's public API rarely moves between patch versions and the
    // alternative is no documentation at all.
    const versions = safeReaddir(dir)
      .filter((v) => fs.existsSync(path.join(dir, v, 'lib')) || fs.existsSync(path.join(dir, v)))
      .sort(compareVersions);
    if (!versions.length) continue;

    const version = versions.at(-1);
    const xml = findNugetXmlDoc(path.join(dir, version));
    if (xml) return { kind: 'nuget', file: xml, version };
  }
  return null;
}

/**
 * The XML doc file for the most modern target framework available.
 *
 * A package carries one `lib/<tfm>/` directory per framework it supports, each
 * with an identical API. Preferring the newest avoids documenting a
 * .NET Framework 4.5 surface for a project on .NET 8.
 */
function findNugetXmlDoc(versionDir) {
  const lib = path.join(versionDir, 'lib');
  const entries = safeReaddir(lib);

  const tfms = entries
    .filter((e) => isDirectory(path.join(lib, e)))
    .sort(compareTargetFrameworks);

  for (const tfm of tfms.reverse()) {
    const xml = safeReaddir(path.join(lib, tfm)).find((f) => f.toLowerCase().endsWith('.xml'));
    if (xml) return path.join(lib, tfm, xml);
  }

  // Packages predating the target-framework convention put assemblies straight
  // in lib/, so an entry there may be a file rather than a directory.
  const flat = entries.find((f) => f.toLowerCase().endsWith('.xml'));
  return flat ? path.join(lib, flat) : null;
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Newer target frameworks sort last: net8.0 > net6.0 > netstandard2.0 > net48. */
function compareTargetFrameworks(a, b) {
  const score = (tfm) => {
    const m = tfm.match(/^net(?:coreapp)?(\d+)\.(\d+)/);
    if (m) return 3000 + Number(m[1]) * 10 + Number(m[2]);
    const std = tfm.match(/^netstandard(\d+)\.(\d+)/);
    if (std) return 2000 + Number(std[1]) * 10 + Number(std[2]);
    const fw = tfm.match(/^net(\d+)$/);
    if (fw) return 1000 + Number(fw[1]);
    return 0;
  };
  return score(a) - score(b);
}

function compareVersions(a, b) {
  const parse = (v) => v.split(/[.\-+]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x === y) continue;
    // A prerelease segment (a string) sorts below a numeric release.
    if (typeof x === 'number' && typeof y === 'string') return 1;
    if (typeof x === 'string' && typeof y === 'number') return -1;
    return x < y ? -1 : 1;
  }
  return 0;
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
  if (located.kind === 'nuget') return extractNuget(located);
  return null;
}

/**
 * Read a NuGet package's API from its XML documentation.
 *
 * No tree-sitter involved: the assembly is compiled, and the XML file is
 * already the public surface with prose attached.
 */
async function extractNuget(located) {
  const xml = readFileSafe(located.file, 8 * 1024 * 1024);
  if (!xml) return null;

  const { parseXmlDoc } = await import('./dotnet-xmldoc.js');
  const { assembly, symbols } = parseXmlDoc(xml);
  if (!symbols.length) return null;

  return { version: located.version, source: 'local', description: assembly, symbols };
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
/**
 * Which pack parses a dependency written in a given language, and which
 * tree-sitter grammar it needs. Kept as data so adding an ecosystem is a
 * one-line change rather than another branch.
 */
const DEP_LANGUAGES = {
  typescript: { pack: 'typescript', grammar: 'typescript' },
  python:     { pack: 'python',     grammar: 'python' },
  java:       { pack: 'java',       grammar: 'java' },
  csharp:     { pack: 'csharp',     grammar: 'c_sharp' },
};

async function parseSymbols(host, langId, source, file) {
  const spec = DEP_LANGUAGES[langId];
  if (!spec) return [];

  const packModule = await import(`../packs/${spec.pack}/index.js`);
  const pack = packModule.default;

  const compiled = {};
  for (const [key, queryFile] of Object.entries(pack.queries)) {
    const text = readFileSafe(queryFile);
    if (text) {
      compiled[key] = await host.query(spec.grammar, `deps:${langId}:${key}`, text, { origin: 'deps' });
    }
  }
  if (!compiled.tags) return [];

  const captures = await host.run(spec.grammar, source, compiled);
  const { nodes } = extract({ path: file, source, captures, pack });

  // Depth 1 is the module's own top level. For Java and C# the public surface
  // sits one level deeper, inside a package or namespace declaration, so both
  // levels count as API.
  const maxDepth = langId === 'java' || langId === 'csharp' ? 3 : 1;

  return nodes
    .filter((n) => n.kind !== 'module' && n.depth <= maxDepth)
    .filter((n) => !n.name.startsWith('_'))                 // conventionally private
    .filter((n) => n.visibility !== 'private' && n.visibility !== 'internal')
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
/**
 * Registry fallback: download the package's own artifact and extract it with
 * the same parsers used for a locally-installed copy.
 *
 * This is the path for a dependency that is not on disk — a fresh checkout, a
 * package restored on another machine, or an ecosystem whose packages are not
 * unpacked locally at all. It fetches the exact artifact the ecosystem
 * publishes, so the result is version-specific and identical to what local
 * extraction would have produced.
 */
async function fetchRegistry(pkg, host) {
  const { fetchPackageArtifact } = await import('./registry.js');
  const artifact = await fetchPackageArtifact(pkg);
  if (!artifact) return null;

  const symbols = await parseArtifact(artifact, host);
  if (!symbols.length) {
    // Reached the registry but found nothing parseable — a package with no
    // types, no XML docs, no sources jar. Recording the version still beats an
    // empty answer, and marks it as known-but-undocumented.
    return {
      version: artifact.version, source: 'registry',
      description: artifact.description ?? null, symbols: [],
    };
  }

  return {
    version: artifact.version,
    source: 'registry',
    description: artifact.description ?? null,
    typesFrom: artifact.typesFrom ?? null,
    symbols,
  };
}

/**
 * Fetch a package's `llms.txt`, if it publishes one.
 *
 * Package archives carry API reference — signatures and doc comments — because
 * that is what is in the source. They cannot carry setup guides or concepts,
 * because those were never in the source. `llms.txt` is the emerging convention
 * for publishing exactly that, and it is the only prose source here.
 *
 * Coverage is thin and growing, so this is best-effort: a miss costs one
 * request and is recorded so it is not retried on every pass.
 */
async function fetchGuide(pkg, config) {
  const homepage = await packageHomepage(pkg);
  if (!homepage) return null;

  const { fetchLlmsTxt } = await import('./registry.js');
  return fetchLlmsTxt(homepage);
}

/**
 * A package's documentation site.
 *
 * Preferring `homepage` over `repository` matters: llms.txt lives on the docs
 * site, and a GitHub URL would 404 every time.
 */
async function packageHomepage(pkg) {
  if (pkg.ecosystem === 'npm' || pkg.ecosystem === 'node') {
    const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(pkg.package).replace('%40', '@')}`);
    const latest = meta?.['dist-tags']?.latest;
    return meta?.versions?.[latest]?.homepage ?? meta?.homepage ?? null;
  }
  if (pkg.ecosystem === 'pypi') {
    const meta = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(pkg.package)}/json`);
    const info = meta?.info ?? {};
    return info.docs_url ?? info.home_page ?? info.project_urls?.Documentation ?? null;
  }
  return null;
}

/**
 * Turn fetched archive members into symbols.
 *
 * Dispatches on the artifact kind rather than the file extension so each
 * ecosystem reuses exactly the parser its local path uses: .d.ts and .pyi go
 * through tree-sitter, .NET XML through the doc parser, Java sources through
 * tree-sitter again.
 */
async function parseArtifact(artifact, host) {
  const out = [];

  if (artifact.kind === 'nuget') {
    const { parseXmlDoc } = await import('./dotnet-xmldoc.js');
    // Newest target framework wins, matching the local NuGet path.
    const names = [...artifact.files.keys()].sort();
    const chosen = names.at(-1);
    if (chosen) out.push(...parseXmlDoc(artifact.files.get(chosen)).symbols);
    return out;
  }

  const langByKind = { npm: 'typescript', python: 'python', maven: 'java' };
  const lang = langByKind[artifact.kind];
  if (!lang || !host) return out;

  // Cap the work: a sources jar holds thousands of files and nobody reads past
  // the first page of any one package's API.
  const entries = [...artifact.files.entries()]
    .filter(([name]) => !name.endsWith('package.json'))
    .slice(0, 40);

  for (const [name, text] of entries) {
    if (!text || text.length > 400_000) continue;
    try {
      out.push(...await parseSymbols(host, lang, text, name));
    } catch {
      // One unparseable member must not discard the rest of the package.
    }
    if (out.length > 400) break;
  }

  return out;
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

    // The guide is prose about the package as a whole, so it hangs off the
    // package row (symbol = '') rather than any one member.
    if (api.guide) {
      store.run(
        `INSERT INTO externals(ecosystem, package, version, symbol, kind, doc, source, use_count)
         VALUES(?, ?, ?, '', 'guide', ?, ?, 0)
         ON CONFLICT(ecosystem, package, symbol)
         DO UPDATE SET doc = excluded.doc, kind = 'guide'`,
        pkg.ecosystem, pkg.package, api.version, api.guide, api.source
      );
    }

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

function readFileSafe(file, maxBytes = 2 * 1024 * 1024) {
  try {
    const stat = fs.statSync(file);
    // A 5 MB bundled .d.ts (looking at you, aws-sdk) yields thousands of
    // symbols nobody asked for and dominates extraction time. XML doc files
    // are legitimately larger, so the cap is per-caller.
    if (stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}
