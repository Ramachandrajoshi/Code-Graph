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
 * The run has four phases, and the split is deliberate:
 *
 *   scan     stat every file, read none. Cheap, and it is what gives the next
 *            phase a total — without it progress can only count upwards, which
 *            on a large repo reads as "no idea how long this will take".
 *   index    read, hash, parse, extract, persist.
 *   resolve  refs -> edges, over the complete symbol table.
 *   rank     PageRank over the edges.
 *
 * Parsing is the only part that parallelises: SQLite has one writer, and the
 * walk is bound by the disk. So on a large run the registry is asked for a
 * pool of parser threads, this thread keeps reading files and writing rows,
 * and batches are handed out as fast as they can be read. Results are written
 * in the order the batches were dispatched, not the order they finished, so
 * node ids — and with them every tie-break in resolution — come out the same
 * whether a run used one thread or sixteen.
 *
 * A small run (an incremental update, the MCP server's freshness check) never
 * starts the pool: spinning up threads to parse three files costs more than
 * parsing them.
 */

import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { walk, classifyFile } from './walker.js';
import { estimate } from './tokens.js';
import { Resolver } from './resolve.js';
import { computeRanks } from './rank.js';

/** A batch is flushed at whichever of these it reaches first. */
const BATCH_FILES = 64;
const BATCH_CHARS = 1 << 20;

/**
 * How many files are being read ahead of the one being processed.
 *
 * Opening a file is the slow part of reading it — on Windows, where every open
 * is also a virus scan, it was a third of the main thread's time — and it is
 * time spent waiting, not computing. Issuing the reads early lets them overlap.
 */
const READ_AHEAD = 32;

/** Unparsed files written per transaction when no parsed batch is due. */
const STUB_BATCH = 512;

/** Below this many files to read, parsing stays on this thread. */
const POOL_THRESHOLD = 300;

export class Indexer {
  /**
   * @param {object} opts
   * @param {import('./store.js').Store} opts.store
   * @param {object} opts.config
   * @param {object} [opts.registry] language pack registry (absent in P0/tests)
   * @param {object} [opts.progress]
   * @param {number} [opts.poolThreshold] files to read before parser threads
   *   are worth starting. Overridable so a test can exercise the pool on a
   *   five-file repo.
   */
  constructor({ store, config, registry = null, progress = null, poolThreshold = POOL_THRESHOLD }) {
    this.store = store;
    this.config = config;
    this.registry = registry;
    this.progress = progress;
    this.poolThreshold = poolThreshold;
    this._stubs = [];
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
      // Where the time went, in ms, and how many threads parsed. Reported so a
      // slow index can be diagnosed from its own output.
      phases: { scan: 0, index: 0, resolve: 0, rank: 0 },
      workers: 1,
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

    // 1. Scan ----------------------------------------------------------------
    // Stat only. Knowing the whole file set before reading any of it is what
    // lets the next phase show a percentage and an estimate, and decide up
    // front whether the job is big enough to deserve parser threads.
    let mark = Date.now();
    this.progress?.phase?.('scanning');

    const entries = [];
    let work = 0;     // progress units: bytes to be read, +1 so empty files count
    let toRead = 0;
    for (const entry of walk(this.config.root, this.config, { readContent: false, isUnchanged: statFilter })) {
      entries.push(entry);
      if (needsRead(entry)) {
        work += entry.size + 1;
        toRead++;
      }
      this.progress?.tick(1, entry.rel);
    }
    stats.phases.scan = Date.now() - mark;

    // 2. Index ---------------------------------------------------------------
    mark = Date.now();
    this.progress?.phase?.('indexing', { total: entries.length, work });

    if (!dryRun && toRead >= this.poolThreshold) {
      const size = parserThreads(this.config.workers, toRead);
      if (size > 1) stats.workers = (await this.registry?.openPool?.(size)) || 1;
    }

    // Batches being parsed, oldest first. Without a pool there is never more
    // than one, and this degenerates to "parse a batch, write it, repeat".
    const inflight = [];
    const maxInflight = stats.workers > 1 ? stats.workers * 2 : 1;
    const dispatch = async (batch) => {
      const parsed = this._parse(batch);
      // Awaited later, in order. Marking it handled now keeps a failure in a
      // later batch from surfacing as an unhandled rejection in the meantime.
      parsed.catch(() => {});
      // Stubs queued so far travel with this batch, so they are written at a
      // point fixed by dispatch order rather than by when a thread happens to
      // finish — row ids stay identical from run to run.
      const stubs = this._stubs;
      this._stubs = [];
      inflight.push({ batch, parsed, stubs });
      while (inflight.length >= maxInflight) await this._settle(inflight.shift(), stats);
    };

    let pending = [];
    let pendingChars = 0;

    // Reads in flight, by position in `entries`. A failed read resolves to
    // null rather than rejecting, so an abandoned one is never unhandled.
    const reads = new Map();
    let primed = 0;
    const readAhead = (upTo) => {
      for (; primed < entries.length && primed <= upTo; primed++) {
        if (needsRead(entries[primed])) {
          reads.set(primed, readFile(entries[primed].abs).catch(() => null));
        }
      }
    };

    try {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        // What this file contributes to the progress bar once it is dealt with.
        const cost = needsRead(entry) ? entry.size + 1 : 0;

        let file = entry;
        if (cost) {
          readAhead(i + READ_AHEAD);
          const buf = await reads.get(i);
          reads.delete(i);
          file = buf ? classifyFile(entry, buf, this.config) : null;
          // Deleted or locked since the scan saw it. Treated as never seen, so
          // a file that was indexed before is evicted below like any deletion.
          if (!file) {
            this.progress?.tick(1, entry.rel, cost);
            continue;
          }
        }

        stats.seen++;
        seen.add(file.rel);
        stats.bytes += file.size;

        // Matched on stat alone; nothing was read.
        if (file.unchanged) {
          stats.unchanged++;
          this.progress?.tick(1, file.rel);
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
          if (!dryRun && !unchanged) {
            this._queueStub(file);
            if (this._stubs.length >= STUB_BATCH) await dispatch([]);
          }
          this.progress?.tick(1, file.rel, cost);
          continue;
        }

        const lang = this.registry?.detect(file.rel, file.content) ?? null;
        if (!lang) {
          stats.skipped++;
          bump(stats.bySkip, 'no-language');
          if (!dryRun && !unchanged) {
            this._queueStub({ ...file, skipReason: 'no-language' });
            if (this._stubs.length >= STUB_BATCH) await dispatch([]);
          }
          this.progress?.tick(1, file.rel, cost);
          continue;
        }

        bump(stats.byLang, lang.id);
        const tok = estimate(file.content);
        stats.tokens += tok;

        if (unchanged) {
          stats.unchanged++;
          this.progress?.tick(1, file.rel, cost);
          continue;
        }

        if (prior) stats.changed++;
        else stats.added++;

        if (dryRun) {
          stats.files.push({ path: file.rel, lang: lang.id, size: file.size, tok });
          this.progress?.tick(1, file.rel, cost);
          continue;
        }

        // Progress for a parsed file is reported when it is written, not when
        // it is read: with a pool the reads run well ahead of the parsing.
        pending.push({ file, lang, tok, cost });
        pendingChars += file.content.length;

        // Flush in batches so memory stays flat on large repos: holding the text
        // of 40,000 files at once is gigabytes. The size cap keeps a run of
        // unusually large files from becoming one indivisible unit of work.
        if (pending.length >= BATCH_FILES || pendingChars >= BATCH_CHARS) {
          await dispatch(pending);
          pending = [];
          pendingChars = 0;
        }
      }

      if (!dryRun) {
        if (pending.length || this._stubs.length) await dispatch(pending);
        while (inflight.length) await this._settle(inflight.shift(), stats);
      }
    } finally {
      // Threads are released before the single-threaded phases, and on any
      // failure: a leaked worker keeps the process alive after the command has
      // printed its error.
      this._stubs = [];
      await this.registry?.closePool?.();
    }
    stats.phases.index = Date.now() - mark;

    if (!dryRun) {
      // Evict files that disappeared from disk.
      this.store.transaction(() => {
        for (const [path, row] of known) {
          if (!seen.has(path)) {
            this.store.removeFile(row.id);
            stats.removed++;
          }
        }
      });

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
        // Both passes are synchronous and take seconds on a large graph.
        // Naming them is the difference between "working" and "hung".
        mark = Date.now();
        this.progress?.phase?.('resolving');
        stats.resolution = new Resolver({
          store: this.store,
          config: this.config,
          registry: this.registry,
          onProgress: (done, total) => this.progress?.update?.(done, total),
        }).run();
        stats.phases.resolve = Date.now() - mark;

        mark = Date.now();
        this.progress?.phase?.('ranking');
        stats.ranking = computeRanks(this.store);
        stats.phases.rank = Date.now() - mark;
      }

      this.store.setMeta('last_indexed_at', Date.now());
      this.store.setMeta('root', this.config.root);
      this.store.setMeta('packs_fingerprint', fingerprint);
      // Every file has now been re-read, which is what the request was for.
      if (force) this.store.clearFullReindex?.();
    }

    this.progress?.done();
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
    const contentDerived = ['binary', 'too-large', 'minified', 'generated', 'no-language', 'image'];
    if (contentDerived.includes(prior.skip_reason)) return true;

    // 'no-queries' and 'parse-error' depend on the packs in play, so they are
    // only reusable while the pack set is identical.
    return this._packsUnchanged;
  }

  /**
   * Stubs are written in groups rather than one at a time. A lone write is its
   * own transaction, and in a typical repo the files that are *not* parsed
   * (assets, lockfiles, languages without queries) outnumber the ones that are
   * — thousands of single-row commits on a fresh index. Queued here, they are
   * written with the next batch to be dispatched.
   */
  _queueStub(file) {
    this._stubs.push(file);
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

  /** Parse a batch. Resolves to null when there is no registry to parse with. */
  async _parse(batch) {
    return this.registry ? this.registry.parseBatch(batch) : null;
  }

  /** Parse one batch and write it, start to finish. */
  async _flush(batch, stats) {
    const stubs = this._stubs;
    this._stubs = [];
    return this._settle({ batch, parsed: this._parse(batch), stubs }, stats);
  }

  /** Wait for one dispatched batch, then write it. */
  async _settle({ batch, parsed, stubs = [] }, stats) {
    const results = await parsed;

    this.store.transaction(() => {
      for (const file of stubs) this._persistStub(file);

      if (!results) {
        // P0 path, and the path tests take when no packs are loaded: record file
        // rows so the index is complete, without symbol extraction.
        for (const { file, lang, tok } of batch) this._persistFileRow(file, lang, tok, 0);
        return;
      }

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

        // _persistFileRow has already cleared whatever the file held before.
        // Clearing a second time here ran nine DELETEs per file against rows
        // that were never there — and one of them has to scan the trigram
        // table, so on a fresh index each file cost more than the one before.
        const fileId = this._persistFileRow(file, lang, tok, 1);
        this.registry.persist(this.store, fileId, file, extraction);
        stats.parsed++;
      }
    });

    for (const item of batch) this.progress?.tick(1, item.file.rel, item.cost);
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

/** A scanned file whose bytes still have to be read to decide anything. */
function needsRead(entry) {
  return !entry.unchanged && !entry.skipReason;
}

/**
 * How many parser threads a run should use.
 *
 * `workers` from config or `--workers` wins when set, and 1 means "no pool".
 * The automatic choice leaves a core for this thread, which is busy reading
 * and writing throughout, and stops at eight: past that the single SQLite
 * writer is the limit and extra parsers only cost memory.
 */
function parserThreads(configured, files) {
  if (configured > 0) return Math.floor(configured);
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, Math.min(cores - 1, 8, Math.ceil(files / 100)));
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
