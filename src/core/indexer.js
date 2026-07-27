/**
 * Indexing pipeline.
 *
 * walk -> detect -> hash -> parse -> extract -> persist -> resolve -> rank
 *
 * The hash check sits early and deliberately: on an incremental run over a repo
 * where three files changed, everything downstream of it must be skipped for the
 * other 40,000. That is the difference between a sub-second update and a slow
 * one, and it is what makes watch mode viable at all.
 *
 * Measured on llama.cpp (3,245 files, 150 MB, 727k LOC):
 *   full index      8.5s
 *   no-op update    0.8s
 *   one file edited 0.9s
 *
 * Parsing is single-threaded. A worker pool was planned, but 8.5s for a full
 * index of a large C++ monorepo is not the bottleneck any user will notice, and
 * the pool would add wasm-per-worker memory cost and a serialization boundary
 * for every extraction result. `parseBatch` is already async and batched, so a
 * pool can be dropped in behind it without touching this file if a repo ever
 * makes it worth doing.
 */

import { walk } from './walker.js';
import { estimate } from './tokens.js';
import { Resolver } from './resolve.js';
import { computeRanks } from './rank.js';

export class Indexer {
  /**
   * @param {object} opts
   * @param {import('./store.js').Store} opts.store
   * @param {object} opts.config
   * @param {object} [opts.registry] language pack registry (absent in P0/tests)
   * @param {object} [opts.progress]
   */
  constructor({ store, config, registry = null, progress = null }) {
    this.store = store;
    this.config = config;
    this.registry = registry;
    this.progress = progress;
  }

  /**
   * Run a full or incremental index.
   *
   * @param {object} opts
   * @param {boolean} [opts.force]  re-parse even when the hash is unchanged
   * @param {boolean} [opts.dryRun] walk and report, write nothing
   */
  async run({ force = false, dryRun = false } = {}) {
    // A migration that added a column only backfillable by re-walking the repo
    // (e.g. schema v3's `subproject`) sets this once, on the one Store.open()
    // call that crosses the schema boundary. Forcing here — not just skipping
    // the stat fast path — is what makes the incremental "unchanged" shortcut
    // below actually re-persist every file instead of leaving the new column
    // null on anything whose bytes didn't change.
    force = force || (!dryRun && this.store?.needsFullReindex === true);

    const started = Date.now();
    const stats = {
      seen: 0, added: 0, changed: 0, unchanged: 0, removed: 0,
      skipped: 0, parsed: 0, failed: 0,
      bytes: 0, tokens: 0,
      byLang: new Map(), bySkip: new Map(),
      files: [],
    };

    // Everything currently in the index. Whatever the walk doesn't visit has
    // been deleted from disk and must be evicted, or the graph keeps answering
    // questions about files that no longer exist.
    const known = dryRun ? new Map() : new Map(
      this.store.allFiles().map((f) => [f.path, f])
    );
    const seen = new Set();

    // Compare the current pack set against what produced the existing index.
    // When it differs, previously unparseable files get another chance.
    const fingerprint = this.registry?.fingerprint() ?? 'none';
    this._packsUnchanged =
      !dryRun && this.store?.getMeta('packs_fingerprint') === fingerprint;

    const pending = [];

    // Stat-level fast path. A file whose size and mtime match the index is not
    // read at all — no I/O beyond the stat the walk already performs. This is
    // what makes a freshness check cheap enough to run on every query: measured
    // on llama.cpp, a no-op pass drops from ~520ms to ~170ms.
    //
    // It is only a fast path, never the decision: anything that fails it still
    // goes through the content hash below, so a file touched without being
    // edited is read once and then correctly not re-parsed.
    const statFilter = force || dryRun ? null : (rel, st) => {
      const prior = known.get(rel);
      if (!prior || prior.mtime !== st.mtime || prior.size !== st.size) return false;
      return this._isUnchanged(prior, { hash: prior.hash });
    };

    for (const file of walk(this.config.root, this.config, { isUnchanged: statFilter })) {
      stats.seen++;
      seen.add(file.rel);
      stats.bytes += file.size;
      this.progress?.tick(1, file.rel);

      // Matched on stat alone; nothing was read.
      if (file.unchanged) {
        stats.unchanged++;
        continue;
      }

      // The hash check comes first, before language detection and before any
      // database write. Skipped files are the majority in most repos, and
      // rewriting their stub rows on every run made a no-op update cost seconds
      // — enough to make watch mode feel broken.
      const prior = known.get(file.rel);
      const unchanged = !force && this._isUnchanged(prior, file);

      if (file.skipReason) {
        stats.skipped++;
        bump(stats.bySkip, file.skipReason);
        if (!dryRun && !unchanged) this._persistStub(file);
        continue;
      }

      const lang = this.registry?.detect(file.rel, file.content) ?? null;
      if (!lang) {
        stats.skipped++;
        bump(stats.bySkip, 'no-language');
        if (!dryRun && !unchanged) this._persistStub({ ...file, skipReason: 'no-language' });
        continue;
      }

      bump(stats.byLang, lang.id);
      const tok = estimate(file.content);
      stats.tokens += tok;

      if (unchanged) {
        stats.unchanged++;
        continue;
      }

      if (prior) stats.changed++;
      else stats.added++;

      if (dryRun) {
        stats.files.push({ path: file.rel, lang: lang.id, size: file.size, tok });
        continue;
      }

      pending.push({ file, lang, tok });

      // Flush in batches so memory stays flat on large repos: holding the text
      // of 40,000 files at once is gigabytes.
      if (pending.length >= 64) {
        await this._flush(pending, stats);
        pending.length = 0;
      }
    }

    if (!dryRun) {
      if (pending.length) await this._flush(pending, stats);

      // Evict files that disappeared from disk.
      for (const [path, row] of known) {
        if (!seen.has(path)) {
          this.store.removeFile(row.id);
          stats.removed++;
        }
      }

      // Resolution and ranking need the complete symbol table, so they run
      // after every file has been parsed rather than per file.
      //
      // They are re-run in full rather than incrementally: a changed file can
      // invalidate edges in any file that imports it, and tracking that
      // precisely is exactly the kind of cache-invalidation bug that produces
      // silently wrong answers. A full pass costs ~1s even on a 700k-line repo,
      // which is a good trade for never serving a stale edge.
      //
      // But it is skipped entirely when nothing changed, so a no-op update —
      // which is what watch mode does most of the time — stays instant.
      const touched = stats.added + stats.changed + stats.removed + stats.failed;
      if (this.registry && touched > 0) {
        this.progress?.done();
        stats.resolution = new Resolver({
          store: this.store,
          config: this.config,
          registry: this.registry,
        }).run();
        stats.ranking = computeRanks(this.store);
      }

      this.store.setMeta('last_indexed_at', Date.now());
      this.store.setMeta('root', this.config.root);
      this.store.setMeta('packs_fingerprint', fingerprint);
    }

    stats.durationMs = Date.now() - started;
    return stats;
  }

  /**
   * Can this file be skipped entirely?
   *
   * Content hash alone is not enough. A file skipped because no pack supplied
   * queries for its language must be reconsidered when packs change — otherwise
   * installing a C++ pack would never take effect on an existing index. But
   * re-deriving that on every run is what made a no-op `update` re-process 1141
   * files, so the decision is keyed on a fingerprint of the loaded packs.
   */
  _isUnchanged(prior, file) {
    if (!prior || prior.hash !== file.hash) return false;
    if (prior.parsed === 1) return true;

    // Skips that follow from the file's own bytes stay valid as long as the
    // bytes do.
    const contentDerived = ['binary', 'too-large', 'minified', 'generated', 'no-language'];
    if (contentDerived.includes(prior.skip_reason)) return true;

    // 'no-queries' and 'parse-error' depend on the packs in play, so they are
    // only reusable while the pack set is identical.
    return this._packsUnchanged;
  }

  /**
   * Record a file we will not parse. Stubs matter: `map` should still show that
   * `logo.png` and `vendor/bundle.js` exist. A graph that silently omits them
   * would send an agent looking for a file it was told doesn't exist.
   */
  _persistStub(file) {
    const existing = this.store.getFileByPath(file.rel);
    if (existing) this.store.clearFileData(existing.id);
    this.store.upsertFile({
      path: file.rel,
      lang: null,
      pack: null,
      hash: file.hash,
      mtime: file.mtime,
      size: file.size,
      loc: 0,
      tok: 0,
      parsed: 0,
      skipReason: file.skipReason,
      subproject: file.subproject ?? null,
    });
  }

  async _flush(batch, stats) {
    if (!this.registry) {
      // P0 path, and the path tests take when no packs are loaded: record file
      // rows so the index is complete, without symbol extraction.
      this.store.transaction(() => {
        for (const { file, lang, tok } of batch) {
          this._persistFileRow(file, lang, tok, 0);
        }
      });
      return;
    }

    const results = await this.registry.parseBatch(batch);

    this.store.transaction(() => {
      for (const result of results) {
        const { file, lang, tok, extraction, error, skipped } = result;

        if (error) {
          stats.failed++;
          this._persistFileRow(file, lang, tok, 0, `parse-error: ${error}`);
          continue;
        }

        // A language with a grammar but no extraction queries is a real and
        // common state (most of the 36 grammars). Counting these as "parsed"
        // would report a healthy index that contains no symbols, so they are
        // recorded as an explicit gap that `doctor` can surface.
        if (skipped) {
          stats.skipped++;
          bump(stats.bySkip, skipped);
          this._persistFileRow(file, lang, tok, 0, skipped);
          continue;
        }

        const fileId = this._persistFileRow(file, lang, tok, 1);
        this.store.clearFileData(fileId);
        this.registry.persist(this.store, fileId, file, extraction);
        stats.parsed++;
      }
    });
  }

  _persistFileRow(file, lang, tok, parsed, skipReason = null) {
    const existing = this.store.getFileByPath(file.rel);
    if (existing) this.store.clearFileData(existing.id);
    return this.store.upsertFile({
      path: file.rel,
      lang: lang?.id ?? null,
      pack: lang?.pack ?? lang?.id ?? null,
      hash: file.hash,
      mtime: file.mtime,
      size: file.size,
      loc: countLines(file.content),
      tok,
      parsed,
      skipReason,
      subproject: file.subproject ?? null,
    });
  }
}

function countLines(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}
