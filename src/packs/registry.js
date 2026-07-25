/**
 * Language pack registry.
 *
 * Discovery order, later overriding earlier:
 *   1. builtin packs shipped here
 *   2. node_modules/cgraph-pack-*      (a pack installs like any dependency)
 *   3. ~/.cgraph/packs/*               (the user's personal packs)
 *   4. .cgraph/packs/*                  (project-local, checked into the repo)
 *
 * A pack is a plain object; every hook on it is optional. The generic path —
 * grammar plus a tags query and nothing else — is a first-class citizen, not a
 * degraded mode, because it is what gives the long tail of languages useful
 * output without anyone writing code for them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ParserHost } from '../core/parser-host.js';
import { extract } from '../core/extract.js';
import { detectLanguage, languageById } from './languages.js';
import { detectTechnologies } from './technologies.js';
import { userCacheDir } from '../core/config.js';

// Order matters: later packs override earlier ones for languages they share.
// `javascript` must follow `typescript` so it wins the `javascript` binding.
const BUILTIN = ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'csharp'];

export class PackRegistry {
  constructor({ config, packs, host }) {
    this.config = config;
    this.packs = packs;          // language id -> pack
    this.host = host;
    this.queryCache = new Map(); // language id -> { tags, imports } source text
    this.missingQueries = new Set();
  }

  /**
   * @param {object} config
   * @param {object} [opts]
   * @param {boolean} [opts.allPacks] load every pack regardless of what the
   *   project appears to use. Only for tooling that must describe the full set,
   *   such as `cgraph packs list`.
   */
  static async load(config, { allPacks = false } = {}) {
    const packs = new Map();

    // What is this project built with? Manifests answer that before a single
    // source file is read, so a .NET repository never loads the Python pack —
    // and never fetches the Python grammar that would come with it.
    const technologies = allPacks ? null : detectTechnologies(config.root);
    const wanted = technologies ? new Set(technologies.languages) : null;

    const sources = [
      ...BUILTIN.map((id) => ({ dir: new URL(`./${id}/`, import.meta.url), origin: `builtin:${id}`, builtin: id })),
      ...discoverExternal(config),
    ];

    for (const src of sources) {
      try {
        const pack = await importPack(src);
        if (!pack) continue;

        const langs = pack.languages ?? [pack.id];

        // Third-party packs are always loaded: someone installed one
        // deliberately, and second-guessing that would make the plugin system
        // unreliable. Only the builtins are filtered by detection.
        const filtered = src.builtin && wanted && !langs.some((l) => wanted.has(l));
        if (filtered) continue;

        for (const lang of langs) {
          // Later sources win, which is what lets a project-local pack override
          // a builtin without forking.
          packs.set(lang, { ...pack, _origin: src.origin });
        }
      } catch (err) {
        // One broken third-party pack must not take down indexing entirely.
        process.emitWarning(`cgraph: failed to load pack ${src.origin}: ${err.message}`);
      }
    }

    const host = new ParserHost({
      offline: config.deps?.offline ?? false,
      onDownload: (name) => process.stderr.write(`  fetching grammar: ${name}\n`),
    });

    const registry = new PackRegistry({ config, packs, host });
    registry.technologies = technologies;
    registry.lazy = !allPacks;
    return registry;
  }

  /**
   * Load a pack that detection did not anticipate.
   *
   * Manifests are a strong signal but not a complete one: a Node repository may
   * still contain a build script in Python or a vendored Go tool. Rather than
   * ignoring those files — which would make the graph lie by omission —
   * discovery only decides what loads *eagerly*, and anything else is loaded on
   * first sight.
   */
  async ensurePackFor(langId) {
    if (this.packs.has(langId) || this._unavailable?.has(langId)) return this.packs.get(langId);
    if (!BUILTIN.includes(langId)) {
      (this._unavailable ??= new Set()).add(langId);
      return null;
    }

    try {
      const pack = await importPack({
        dir: new URL(`./${langId}/`, import.meta.url), origin: `builtin:${langId}`,
      });
      if (!pack) return null;
      for (const lang of pack.languages ?? [pack.id]) {
        if (!this.packs.has(lang)) this.packs.set(lang, { ...pack, _origin: `builtin:${langId}` });
      }
      this._fingerprint = null;   // the pack set changed
      return this.packs.get(langId);
    } catch (err) {
      process.emitWarning(`cgraph: failed to load pack ${langId}: ${err.message}`);
      (this._unavailable ??= new Set()).add(langId);
      return null;
    }
  }

  /**
   * Language for a file, or null. Returns a descriptor rather than a pack: a
   * language can be detected (so `map` can label the file) even when no pack
   * supplies extraction queries for it.
   */
  detect(relPath, content) {
    const lang = detectLanguage(relPath, content);
    if (!lang) return null;

    const disabled = this.config.packs?.disable ?? [];
    if (disabled.includes(lang.id)) return null;

    const enabled = this.config.packs?.enable ?? [];
    if (enabled.length && !enabled.includes(lang.id)) return null;

    return { id: lang.id, grammar: lang.grammar, pack: this.packs.get(lang.id)?.id ?? null };
  }

  /** The pack for a language, or a minimal generic one. */
  packFor(langId) {
    return this.packs.get(langId) ?? { id: `generic:${langId}`, _origin: 'generic' };
  }

  /**
   * Load query sources for a language.
   *
   * A language with a grammar but no tags query yields no symbols. That is a
   * real state for most of the 36 grammars right now, so it is reported once
   * rather than silently producing an empty graph the user cannot explain.
   */
  queriesFor(langId) {
    if (this.queryCache.has(langId)) return this.queryCache.get(langId);

    const pack = this.packs.get(langId);
    const out = {};

    if (pack?.queries) {
      for (const [key, file] of Object.entries(pack.queries)) {
        try {
          out[key] = fs.readFileSync(file, 'utf8');
        } catch (err) {
          process.emitWarning(
            `cgraph: pack '${pack.id}' declares query '${key}' at ${file} but it could not be read: ${err.message}`
          );
        }
      }
    }

    if (!out.tags) this.missingQueries.add(langId);
    this.queryCache.set(langId, out);
    return out;
  }

  /**
   * Parse and extract a batch of files.
   *
   * Errors are captured per file rather than thrown: one file with a grammar
   * edge case must not abort an index of forty thousand.
   */
  async parseBatch(batch) {
    const results = [];

    for (const item of batch) {
      const { file, lang, tok } = item;
      try {
        // A language detection that discovery did not predict — a build script
        // in an unexpected language — loads its pack now rather than being
        // silently skipped.
        if (this.lazy && !this.packs.has(lang.id)) await this.ensurePackFor(lang.id);

        const querySources = this.queriesFor(lang.id);
        if (!querySources.tags) {
          results.push({ ...item, extraction: null, error: null, skipped: 'no-queries' });
          continue;
        }

        const pack = this.packFor(lang.id);
        const compiled = {};
        for (const [key, src] of Object.entries(querySources)) {
          compiled[key] = await this.host.query(lang.grammar, `${lang.id}:${key}`, src, {
            origin: pack._origin ?? pack.id,
          });
        }

        const captures = await this.host.run(lang.grammar, file.content, compiled);
        const extraction = extract({
          path: file.rel,
          source: file.content,
          captures,
          pack,
        });

        results.push({ ...item, extraction, error: null });
      } catch (err) {
        results.push({ ...item, extraction: null, error: err.message });
      }
    }

    return results;
  }

  /**
   * Write an extraction to the store.
   *
   * Node ids are assigned as rows are inserted, so parent links and reference
   * sources are carried as array indexes through extraction and mapped to real
   * ids here. Doing it the other way round would require a second update pass
   * over every node.
   */
  persist(store, fileId, file, extraction) {
    if (!extraction) return;

    const ids = new Array(extraction.nodes.length);

    for (let i = 0; i < extraction.nodes.length; i++) {
      const n = extraction.nodes[i];
      ids[i] = store.insertNode({
        fileId,
        parentId: n.parentIndex === null ? null : ids[n.parentIndex],
        kind: n.kind,
        name: n.name,
        qname: n.qname,
        startLine: n.startLine,
        endLine: n.endLine,
        startByte: n.startByte,
        endByte: n.endByte,
        signature: n.signature,
        doc: n.doc,
        visibility: n.visibility,
        isExported: n.isExported,
        tok: n.tok,
      });
    }

    // References are queued, not resolved. Linking them to targets needs the
    // whole repo's symbol table, so it happens in a separate pass once every
    // file has been indexed.
    const insertRef = store.stmt(
      `INSERT INTO refs(file_id, src_id, name, receiver, kind, line)
       VALUES(?, ?, ?, ?, ?, ?)`
    );
    for (const ref of extraction.refs) {
      const srcId = ids[ref.fromIndex];
      if (srcId === undefined) continue;
      insertRef.run(fileId, srcId, ref.name, ref.receiver ?? null, ref.kind, ref.line);
    }

    const insertImport = store.stmt(
      `INSERT INTO imports(file_id, spec, symbol, alias, line) VALUES(?, ?, ?, ?, ?)`
    );
    for (const imp of extraction.imports) {
      insertImport.run(fileId, imp.spec, imp.symbol ?? null, imp.alias ?? null, imp.line);
    }

    return ids;
  }

  /** Languages seen with a grammar but no extraction queries. */
  gaps() {
    return [...this.missingQueries];
  }

  /**
   * A stable digest of the loaded packs and their query sources.
   *
   * The indexer uses this to decide whether files it previously could not parse
   * deserve another attempt. Query file *contents* are hashed, not just pack
   * names, so that editing a .scm during pack development takes effect on the
   * next index without needing --force.
   */
  fingerprint() {
    if (this._fingerprint) return this._fingerprint;

    const parts = [];
    for (const [lang, pack] of [...this.packs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      parts.push(`${lang}:${pack.id}:${pack._origin ?? ''}`);
      for (const [key, file] of Object.entries(pack.queries ?? {}).sort()) {
        try {
          parts.push(`${key}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)}`);
        } catch {
          parts.push(`${key}:missing`);
        }
      }
    }

    this._fingerprint = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
    return this._fingerprint;
  }

  dispose() {
    this.host.dispose();
  }
}

function discoverExternal(config) {
  const found = [];

  const dirs = [
    { base: path.join(config.root, 'node_modules'), prefixed: true, label: 'node_modules' },
    { base: path.join(userCacheDir(), 'packs'), prefixed: false, label: 'user' },
    { base: path.join(config.dir, 'packs'), prefixed: false, label: 'project' },
  ];

  for (const { base, prefixed, label } of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (prefixed && !entry.name.startsWith('cgraph-pack-')) continue;

      found.push({
        dir: pathToFileURL(path.join(base, entry.name) + path.sep),
        origin: `${label}:${entry.name}`,
      });
    }
  }

  return found;
}

async function importPack({ dir, origin }) {
  const entry = new URL('index.js', dir);
  if (!fs.existsSync(entry)) return null;

  const mod = await import(entry.href);
  const pack = mod.default ?? mod.pack;
  if (!pack || typeof pack !== 'object') {
    throw new Error('pack module has no default export object');
  }
  if (!pack.id) throw new Error('pack is missing an id');
  return pack;
}
