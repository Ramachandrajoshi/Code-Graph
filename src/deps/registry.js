/**
 * Registry fetching.
 *
 * Every ecosystem publishes the same artifact cgraph reads off disk. When a
 * dependency is not installed locally — a CI checkout, a package removed from
 * node_modules, a NuGet package restored on another machine — the archive is
 * still one HTTP request away, and extracting it feeds the *same* parsers.
 *
 * That is the whole design: this module downloads and unpacks, it does not
 * understand any language. Nothing here scrapes a documentation website, so
 * there is no per-site fragility and no HTML-to-text pipeline to maintain.
 *
 * What this gives you is API reference — signatures and doc comments for the
 * exact version resolved. It does not give you prose guides; `llms.txt` covers
 * some of that, and a docs-focused MCP server covers the rest. Being clear
 * about that boundary is better than pretending one source does everything.
 */

import { readArchive } from './archive.js';

const TIMEOUT_MS = 20000;
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;

/**
 * Fetch and unpack a dependency's documentation artifact.
 *
 * @returns {Promise<{version, files: Map<string, string>, kind} | null>}
 *   `files` maps archive path to text. `kind` tells the caller which parser to
 *   use, mirroring the local `locate()` result so both paths converge.
 */
export async function fetchPackageArtifact(pkg, { onProgress = null } = {}) {
  onProgress?.(pkg.package);

  switch (pkg.ecosystem) {
    case 'npm':
    case 'node':
      return fetchNpm(pkg.package);
    case 'nuget':
    case 'dotnet':
      return fetchNuget(pkg.package);
    case 'maven':
      return fetchMaven(pkg.package);
    case 'pypi':
      return fetchPypi(pkg.package);
    default:
      return null;
  }
}

// ---------------------------------------------------------------- npm

async function fetchNpm(name) {
  const own = await fetchNpmTarball(name);
  if (own?.files.size) return own;

  // A large share of npm ships no types of its own — express, lodash and most
  // packages predating TypeScript — and the community publishes them separately
  // on DefinitelyTyped. Looking there is exactly what a developer does next, and
  // costs one more request.
  const typesName = toTypesPackage(name);
  if (!typesName) return own;

  const types = await fetchNpmTarball(typesName);
  if (!types?.files.size) return own;

  return {
    ...types,
    // Report the version of the package being documented, not of its types.
    version: own?.version ?? types.version,
    description: own?.description ?? types.description,
    typesFrom: typesName,
  };
}

async function fetchNpmTarball(name) {
  const meta = await getJson(`https://registry.npmjs.org/${encodeName(name)}`);
  const version = meta?.['dist-tags']?.latest;
  const info = version ? meta.versions?.[version] : null;
  const tarball = info?.dist?.tarball;
  if (!tarball) return null;

  const buf = await getBuffer(tarball);
  if (!buf) return null;

  // Type declarations only. Pulling the implementation would multiply the
  // download for source we would immediately discard.
  const files = extractText(buf, (n) => n.endsWith('.d.ts'));
  return { version, files, kind: 'npm', description: info.description };
}

/** `express` -> `@types/express`; `@scope/pkg` -> `@types/scope__pkg`. */
function toTypesPackage(name) {
  if (name.startsWith('@types/')) return null;
  if (name.startsWith('@')) {
    const [scope, pkg] = name.slice(1).split('/');
    return pkg ? `@types/${scope}__${pkg}` : null;
  }
  return `@types/${name}`;
}

// ---------------------------------------------------------------- nuget

async function fetchNuget(name) {
  const id = name.toLowerCase();
  const index = await getJson(`https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(id)}/index.json`);
  const version = pickLatestStable(index?.versions);
  if (!version) return null;

  const buf = await getBuffer(
    `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(id)}/${version}/${encodeURIComponent(id)}.${version}.nupkg`
  );
  if (!buf) return null;

  // XML documentation only — the DLLs beside it are compiled and useless here,
  // and they are the bulk of the archive.
  const files = extractText(buf, (n) => n.toLowerCase().endsWith('.xml') && n.toLowerCase().startsWith('lib/'));
  return files.size ? { version, files, kind: 'nuget' } : null;
}

// ---------------------------------------------------------------- maven

/**
 * Maven coordinates are `groupId:artifactId`, and cgraph only sees a package
 * name derived from a Java import (`com.fasterxml.jackson`). Search resolves
 * that to real coordinates before the sources jar can be located.
 */
async function fetchMaven(name) {
  const query = name.includes(':')
    ? `g:${name.split(':')[0]} AND a:${name.split(':')[1]}`
    : `g:${name}`;

  const search = await getJson(
    `https://search.maven.org/solrsearch/select?q=${encodeURIComponent(query)}&rows=20&wt=json`
  );
  const docs = search?.response?.docs ?? [];
  if (!docs.length) return null;

  // A group holds many artifacts, and the first result is often a variant:
  // searching `com.google.guava` returns guava-gwt before guava. The artifact
  // named after the group's last segment is nearly always the one meant.
  const preferred = name.includes(':') ? name.split(':')[1] : name.split('.').at(-1);
  const doc =
    docs.find((d) => d.a === preferred) ??
    docs.find((d) => !/-(gwt|testlib|parent|bom|annotations)$/.test(d.a)) ??
    docs[0];

  const group = doc.g.replace(/\./g, '/');
  const artifact = doc.a;
  const version = doc.latestVersion ?? doc.v;
  if (!version) return null;

  const buf = await getBuffer(
    `https://repo1.maven.org/maven2/${group}/${artifact}/${version}/${artifact}-${version}-sources.jar`
  );
  // A sources jar is optional; many artifacts publish none, and that is a
  // normal outcome rather than an error.
  if (!buf) return null;

  const files = extractText(buf, (n) => n.endsWith('.java') && !n.includes('/internal/'));
  return files.size ? { version, files, kind: 'maven', coordinates: `${doc.g}:${artifact}` } : null;
}

// ---------------------------------------------------------------- pypi

async function fetchPypi(name) {
  const meta = await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  const version = meta?.info?.version;
  if (!version) return null;

  // Prefer a wheel: it is the built distribution and contains the .pyi stubs
  // when a package ships them. Fall back to the sdist.
  const urls = meta.urls ?? [];
  const wheel = urls.find((u) => u.packagetype === 'bdist_wheel');
  const sdist = urls.find((u) => u.packagetype === 'sdist');
  const chosen = wheel ?? sdist;
  if (!chosen?.url) return null;

  const buf = await getBuffer(chosen.url);
  if (!buf) return null;

  const files = extractText(buf, (n) =>
    (n.endsWith('.pyi') || n.endsWith('__init__.py')) && !n.includes('/test'));
  return files.size
    ? { version, files, kind: 'python', description: meta.info.summary }
    : null;
}

// ---------------------------------------------------------------- llms.txt

/**
 * Fetch a project's `llms.txt`, an emerging convention for publishing
 * LLM-readable documentation at a well-known path.
 *
 * This is the one source here that carries *prose* — setup guides, concepts,
 * the things a package archive cannot contain because they were never in the
 * source. Coverage is thin and growing, so this is best-effort by design: a
 * miss is silent and costs one request.
 *
 * `llms-full.txt` is tried first where sites publish both, since the short form
 * is usually a link index rather than content.
 */
export async function fetchLlmsTxt(homepage, { maxBytes = 200_000 } = {}) {
  const base = normalizeHomepage(homepage);
  if (!base) return null;

  for (const suffix of ['llms-full.txt', 'llms.txt']) {
    const url = `${base}/${suffix}`;
    const text = await getText(url, maxBytes);
    // A site without llms.txt very often serves its index.html for any unknown
    // path, so the content type is not enough — HTML has to be rejected.
    if (text && !looksLikeHtml(text)) {
      return { url, text: text.slice(0, maxBytes) };
    }
  }
  return null;
}

function normalizeHomepage(homepage) {
  if (!homepage || typeof homepage !== 'string') return null;
  try {
    const url = new URL(homepage.startsWith('http') ? homepage : `https://${homepage}`);
    if (!/^https?:$/.test(url.protocol)) return null;
    // A GitHub repository is not a docs site; llms.txt lives on the project's
    // own domain, so guessing github.com/... would just 404 every time.
    if (/^(www\.)?github\.com$/.test(url.hostname)) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function looksLikeHtml(text) {
  const head = text.slice(0, 200).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html');
}

// ---------------------------------------------------------------- transport

function encodeName(name) {
  // Scoped packages keep their slash: @scope/pkg -> @scope%2Fpkg
  return name.startsWith('@')
    ? `${encodeURIComponent(name.split('/')[0])}%2F${encodeURIComponent(name.split('/')[1] ?? '')}`
    : encodeURIComponent(name);
}

/** Newest version that is not a prerelease, since that is what a reader means. */
function pickLatestStable(versions) {
  if (!Array.isArray(versions) || !versions.length) return null;
  const stable = versions.filter((v) => !/[-+]/.test(v));
  return (stable.length ? stable : versions).at(-1);
}

function extractText(buf, filter) {
  const out = new Map();
  try {
    for (const [name, data] of readArchive(buf, filter)) {
      out.set(name, data.toString('utf8'));
    }
  } catch {
    // A corrupt or unsupported archive yields nothing rather than failing the
    // whole documentation pass.
  }
  return out;
}

async function getJson(url) {
  const text = await getText(url, 8 * 1024 * 1024);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function getText(url, maxBytes) {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json, text/plain, */*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared && declared > maxBytes) return null;

    return await res.text();
  } catch {
    // Offline, DNS failure, rate limit, timeout. Documentation is an
    // enhancement; never let its absence fail anything.
    return null;
  }
}

async function getBuffer(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared && declared > MAX_ARCHIVE_BYTES) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > MAX_ARCHIVE_BYTES ? null : buf;
  } catch {
    return null;
  }
}
