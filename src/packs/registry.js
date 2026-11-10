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
import { isTrusted } from '../core/trust.js';

// Order matters: later packs override earlier ones for languages they share.
// `javascript` must follow `typescript` so it wins the `javascript` binding.
// 'yaml' is deliberately absent: the bundled tree-sitter-yaml.wasm
// (tree-sitter-wasms@0.1.13) fails to parse anything at all under the pinned
// web-tree-sitter@0.25.10 (an external-scanner symbol resolution error, not a
// query problem — see src/packs/yaml/index.js). Registering it would turn
// today's clean "no extraction queries yet" skip into a parse error on every
// YAML file. Add 'yaml' back once that combination is fixed upstream.
const BUILTIN = ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'csharp',
  'json', 'css', 'html', 'bash'];

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
  static async load(config, { allPacks = false, trusted = isTrusted(config.root) } = {}) {
    const packs = new Map();
    const external = discoverExternal(config, trusted);

    if (external.blocked.length) {
      // Loud, because the alternative reads as "my pack does nothing": the
      // files are there, the index runs, and no symbols appear.
      process.emitWarning(
        `cgraph: not loading ${external.blocked.join(', ')} — packs inside a project are ` +
        'code, and this project is not trusted to run code. Review them, then run `cgraph trust`.'
      );
    }

    // What is this project built with? Manifests answer that before a single
    // source file is read, so a .NET repository never loads the Python pack —
    // and never fetches the Python grammar that would come with it.
    const technologies = allPacks ? null : detectTechnologies(config.root);
    const wanted = technologies ? new Set(technologies.languages) : null;

    const sources = [
      ...BUILTIN.map((id) => ({ dir: new URL(`./${id}/`, import.meta.url), origin: `builtin:${id}`, builtin: id })),
      ...external.found,
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
    registry.blockedPacks = external.blocked;
    registry.lazy = !allPacks;
    registry.strict = config.packs?.strict ?? false;
    // Kept so parser threads can load a registry that matches this one exactly.
    registry.loadOptions = { allPacks, trusted };
    return registry;
  }

  /**
   * Start parser threads. Until `closePool`, `parseBatch` hands its work to
   * them instead of parsing on this thread.
   *
   * Returns how many threads are running, or 0 when a pool could not be
   * started — in which case nothing changes and parsing simply stays here.
   * Only a registry built by `load` can be pooled: the workers have to be able
   * to rebuild it from config.
   */
  async openPool(size) {
    if (this.pool || !this.loadOptions || size < 2) return this.pool?.size ?? 0;
    try {
      const { ParsePool } = await import('./parse-pool.js');
      this.pool = new ParsePool(size, { config: this.config, loadOptions: this.loadOptions });
      return this.pool.size;
    } catch {
      // No worker_threads, or a config that cannot be cloned to one.
      this.pool = null;
      return 0;
    }
  }

  async closePool() {
    const pool = this.pool;
    this.pool = null;
    await pool?.close();
  }

  /**
   * Load a pack that detection did not anticipate.
   *
   * Manifests are a strong signal but not a complete one: a Node repository may
   * still contain a build script in Python or a vendored Go tool. Rather than
   * ignoring those files — which would make the graph lie by omission —
   * discovery only decides what loads *eagerly*, and anything else is loaded on
   * first sight.
   *
   * Unless `strict` is set: a project can decide it only ever wants exactly
   * what manifest-based detection found, trading that safety net for never
   * pulling in a grammar+pack the project's own manifests gave no signal for.
   */
  async ensurePackFor(langId) {
    if (this.packs.has(langId) || this._unavailable?.has(langId)) return this.packs.get(langId);

    // A language is not always served by a pack of the same name: `tsx` comes
    // from the typescript pack. Looking only for a directory called `tsx`
    // found nothing, marked the language unavailable for the rest of the run,
    // and a .tsx file met before any .ts file was recorded as having no
    // queries — in a repository that parsed its .ts files perfectly well.
    const packId = this.strict ? null : await builtinPackFor(langId);
    if (!packId) {
      (this._unavailable ??= new Set()).add(langId);
      return null;
    }

    try {
      const pack = await importPack({
        dir: new URL(`./${packId}/`, import.meta.url), origin: `builtin:${packId}`,
      });
      if (!pack) return null;
      for (const lang of pack.languages ?? [pack.id]) {
        if (!this.packs.has(lang)) this.packs.set(lang, { ...pack, _origin: `builtin:${packId}` });
        // Anything concluded about this language before its pack arrived —
        // "no queries", chiefly — was about its absence and no longer holds.
        this.queryCache.delete(lang);
        this.missingQueries.delete(lang);
        this._unavailable?.delete(lang);
      }
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
    return this.pool ? this._parsePooled(batch) : this._parseInline(batch);
  }

  /**
   * `parseBatch` with the parsing done on a pool thread.
   *
   * Everything that changes this registry's own state still happens here, so
   * the main thread ends a pooled run knowing exactly what an inline run would
   * have taught it: lazily-loaded packs are loaded (the resolver needs their
   * hooks), languages without queries are recorded as gaps and never sent, and
   * each grammar is fetched once up front rather than raced for by every
   * thread that meets the language at the same moment.
   */
  async _parsePooled(batch) {
    const results = new Array(batch.length);
    const sent = [];

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const { lang } = item;
      try {
        if (this.lazy && !this.packs.has(lang.id)) await this.ensurePackFor(lang.id);
        if (!this.queriesFor(lang.id).tags) {
          results[i] = { ...item, extraction: null, error: null, skipped: 'no-queries' };
          continue;
        }
        await this.host.prefetch(lang.grammar);
        sent.push(i);
      } catch (err) {
        results[i] = { ...item, extraction: null, error: err.message };
      }
    }

    if (sent.length) {
      let parsed;
      try {
        parsed = await this.pool.run(
          sent.map((i) => ({ rel: batch[i].file.rel, content: batch[i].file.content, lang: batch[i].lang }))
        );
      } catch {
        // The thread holding this batch was lost. Parse it here instead: slower
        // for these files, but nothing is dropped and the run carries on.
        parsed = await this._parseInline(sent.map((i) => batch[i]));
      }

      sent.forEach((i, k) => {
        const { extraction, error, skipped } = parsed[k];
        results[i] = { ...batch[i], extraction, error };
        if (skipped) results[i].skipped = skipped;
      });
    }

    return results;
  }

  async _parseInline(batch) {
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
        body: n.body,
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
    const loadedBuiltins = new Set();

    for (const [lang, pack] of [...this.packs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const origin = pack._origin ?? '';
      if (origin.startsWith('builtin:')) {
        loadedBuiltins.add(origin.slice('builtin:'.length));
        continue;
      }
      parts.push(`${lang}:${pack.id}:${origin}`);
      for (const [key, file] of Object.entries(pack.queries ?? {}).sort()) {
        try {
          parts.push(`${key}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)}`);
        } catch {
          parts.push(`${key}:missing`);
        }
      }
    }

    // Builtins are fingerprinted by what is on disk, not by what happens to be
    // loaded. A builtin loads lazily the first time its language is seen, so
    // "the loaded set" was different at the start of a run than at the end of
    // it — and different again in the next process. Every run therefore
    // disagreed with the fingerprint the previous one stored, concluded the
    // packs had changed, re-read every file it had skipped for lack of queries
    // and re-resolved the whole graph: once after each real change in a
    // long-lived server, and again each time the CLI and the server took
    // turns. Under `strict` nothing loads lazily, so only what detection
    // loaded counts.
    for (const id of [...BUILTIN].sort()) {
      if (this.strict && !loadedBuiltins.has(id)) continue;
      parts.push(`builtin:${id}:${hashQueryDir(id)}`);
    }
    parts.push(`strict:${this.strict ? 1 : 0}`);

    this._fingerprint = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
    return this._fingerprint;
  }

  dispose() {
    // Not awaited: dispose is synchronous for its callers, and terminating a
    // thread needs no cooperation from it.
    this.closePool();
    this.host.dispose();
  }
}

/**
 * Packs outside the builtins.
 *
 * The two sources that live under the project root are only loaded for a
 * trusted project (see core/trust.js): importing a pack executes it, and a
 * cloned repository must not get to run code merely by being indexed. Packs in
 * the user's own cache directory were put there by the user and always load.
 * What was held back is returned too, so the caller can say so.
 */
function discoverExternal(config, trusted) {
  const found = [];
  const blocked = [];

  const dirs = [
    { base: path.join(config.root, 'node_modules'), prefixed: true, label: 'node_modules', inProject: true },
    { base: path.join(userCacheDir(), 'packs'), prefixed: false, label: 'user', inProject: false },
    { base: path.join(config.dir, 'packs'), prefixed: false, label: 'project', inProject: true },
  ];

  for (const { base, prefixed, label, inProject } of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (prefixed && !entry.name.startsWith('cgraph-pack-')) continue;

      const origin = `${label}:${entry.name}`;
      if (inProject && !trusted) {
        blocked.push(origin);
        continue;
      }

      found.push({ dir: pathToFileURL(path.join(base, entry.name) + path.sep), origin });
    }
  }

  return { found, blocked };
}

/** Digest of a builtin pack's query files, or 'none' if it ships none. */
function hashQueryDir(id) {
  const dir = new URL(`./${id}/queries/`, import.meta.url);
  try {
    const hash = createHash('sha256');
    for (const name of fs.readdirSync(dir).sort()) {
      hash.update(name).update(fs.readFileSync(new URL(name, dir)));
    }
    return hash.digest('hex').slice(0, 16);
  } catch {
    return 'none';
  }
}

/**
 * Which builtin pack serves a language, or null.
 *
 * Usually the pack named after it. Otherwise each builtin is asked what it
 * declares — an import of a small module apiece, done once and only for a
 * language that had no pack of its own name.
 */
let languageOwners = null;
async function builtinPackFor(langId) {
  if (BUILTIN.includes(langId)) return langId;
  if (!languageOwners) {
    languageOwners = new Map();
    for (const id of BUILTIN) {
      try {
        const pack = await importPack({ dir: new URL(`./${id}/`, import.meta.url), origin: `builtin:${id}` });
        for (const lang of pack?.languages ?? []) {
          if (!languageOwners.has(lang)) languageOwners.set(lang, id);
        }
      } catch {
        // A builtin that cannot be imported serves no languages.
      }
    }
  }
  return languageOwners.get(langId) ?? null;
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
