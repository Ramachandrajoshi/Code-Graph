/**
 * Grammar resolution.
 *
 * The 36 tree-sitter grammars total 51.8 MB. Bundling all of them would make
 * `npm i -g cgraph` a 50 MB download for a user whose repo is one language,
 * which directly undermines the "installs cleanly anywhere" promise. So:
 *
 *   1. shared user cache   ~/.cgraph/grammars/   (populated on first use)
 *   2. tree-sitter-wasms   optionalDependency        (offline / pre-seeded)
 *   3. CDN download        unpkg                     (verified against manifest)
 *
 * Only grammars for languages actually present in a repo are ever fetched, and
 * the cache is machine-wide so a second project pays nothing.
 *
 * ABI WARNING: `web-tree-sitter` is pinned to ~0.25.10 because the 0.26 line
 * cannot load the grammars in tree-sitter-wasms@0.1.13 — the wasm dylink ABI
 * changed. The failure mode is vicious: `Language.load` throws an Error whose
 * message is the empty string, from deep inside the emscripten loader, so it
 * looks like a bug in this code rather than a version mismatch. Do not bump the
 * runtime without re-running `test/grammars.test.js`, which loads every grammar.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { userCacheDir } from './config.js';
import manifest from './grammar-manifest.json' with { type: 'json' };

const require = createRequire(import.meta.url);

const CDN = (name) =>
  `https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-${name}.wasm`;

export const KNOWN_GRAMMARS = Object.keys(manifest.grammars);

export function grammarInfo(name) {
  return manifest.grammars[name] ?? null;
}

function cachePath(name) {
  return path.join(userCacheDir(), 'grammars', `tree-sitter-${name}.wasm`);
}

/** Path to the grammar inside the optional `tree-sitter-wasms` package, if installed. */
function bundledPath(name) {
  try {
    const pkg = require.resolve('tree-sitter-wasms/package.json');
    const file = path.join(path.dirname(pkg), 'out', `tree-sitter-${name}.wasm`);
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Verify a grammar's bytes against the manifest.
 *
 * Grammars are WebAssembly that we execute, fetched over the network. Checking
 * the digest is not optional — an unverified download is arbitrary code
 * execution on the developer's machine.
 */
function verify(name, buf) {
  const info = grammarInfo(name);
  if (!info) return; // Unknown grammar (a third-party pack shipped its own).
  const got = sha256(buf);
  if (got !== info.sha256) {
    throw new Error(
      `Grammar checksum mismatch for '${name}'.\n` +
        `  expected ${info.sha256}\n  got      ${got}\n` +
        'Refusing to load. Delete the cached file and retry, or pre-install tree-sitter-wasms.'
    );
  }
}

/**
 * Resolve a grammar to a local file path, downloading it if needed.
 * Returns `{ path, source }` where source is cache | bundled | downloaded.
 */
export async function resolveGrammar(name, { offline = false, onDownload = null } = {}) {
  const info = grammarInfo(name);
  if (info && info.abiOk === false) {
    // Fail here with an explanation rather than letting the wasm loader throw an
    // empty-message Error that points nowhere.
    throw new Error(
      `Grammar '${name}' is not loadable by the pinned tree-sitter runtime ` +
        `(${manifest.runtime?.range ?? 'current'}). Files in this language are ` +
        'indexed as stubs: they appear in the map but have no extracted symbols.'
    );
  }

  const cached = cachePath(name);
  if (fs.existsSync(cached)) {
    // Trust but verify: a truncated download from a previous interrupted run
    // would otherwise fail deep inside the wasm loader with a useless message.
    const buf = fs.readFileSync(cached);
    try {
      verify(name, buf);
      return { path: cached, source: 'cache' };
    } catch {
      fs.rmSync(cached, { force: true });
    }
  }

  const bundled = bundledPath(name);
  if (bundled) return { path: bundled, source: 'bundled' };

  if (offline) {
    throw new Error(
      `Grammar '${name}' is not available offline.\n` +
        'Fix: run `npm i tree-sitter-wasms`, or re-run without --offline.'
    );
  }

  if (!grammarInfo(name)) {
    throw new Error(
      `Unknown grammar '${name}'. Known: ${KNOWN_GRAMMARS.slice(0, 8).join(', ')}...\n` +
        'A language pack shipping its own grammar must give an absolute path.'
    );
  }

  onDownload?.(name);
  const buf = await download(CDN(name));
  verify(name, buf);

  fs.mkdirSync(path.dirname(cached), { recursive: true });
  // Write to a temp file then rename, so a killed process cannot leave a
  // half-written grammar that looks complete to the next run.
  const tmp = `${cached}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, cached);

  return { path: cached, source: 'downloaded' };
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Failed to download grammar: ${res.status} ${res.statusText} (${url})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Which grammars are already available locally, without touching the network. */
export function localGrammars() {
  const out = new Map();
  for (const name of KNOWN_GRAMMARS) {
    if (fs.existsSync(cachePath(name))) out.set(name, 'cache');
    else if (bundledPath(name)) out.set(name, 'bundled');
  }
  return out;
}
