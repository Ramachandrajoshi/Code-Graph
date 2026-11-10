/**
 * A pool of parser threads.
 *
 * Parsing and extraction are pure CPU work on one file at a time, with no
 * shared state — the one stage of indexing that can use more than one core.
 * Everything else (the walk, SQLite) stays on the main thread.
 *
 * Each worker loads its own registry, because a pack is code: its hooks are
 * functions and cannot be sent across a thread boundary. What does cross is
 * plain data in both directions — file text out, extraction records back.
 *
 * Failure is contained rather than fatal. A worker that dies (a pack that
 * throws at import, a wasm trap) rejects the batch it was holding and leaves
 * the pool; the registry re-parses that batch on the main thread. Losing every
 * worker degrades a run to single-threaded, never to a failed index.
 */

import { Worker } from 'node:worker_threads';

export class ParsePool {
  /**
   * @param {number} size
   * @param {object} workerData  `{ config, loadOptions }` for the worker's registry
   */
  constructor(size, workerData) {
    this.slots = new Set();
    this.idle = [];
    this.queue = [];
    this.closed = false;
    for (let i = 0; i < size; i++) this._spawn(workerData);
  }

  get size() {
    return this.slots.size;
  }

  _spawn(workerData) {
    const worker = new Worker(new URL('./parse-worker.js', import.meta.url), { workerData });
    const slot = { worker, job: null };

    worker.on('message', (msg) => {
      const job = slot.job;
      slot.job = null;
      if (job) {
        if (msg.error) job.reject(new Error(msg.error));
        else job.resolve(msg.results);
      }
      this.idle.push(slot);
      this._pump();
    });

    const lost = (err) => {
      if (!this.slots.delete(slot)) return;
      this.idle = this.idle.filter((s) => s !== slot);
      slot.job?.reject(err);
      slot.job = null;
      // Nothing left to hand queued work to; let the callers fall back.
      if (!this.slots.size) {
        for (const job of this.queue.splice(0)) job.reject(err);
      }
    };
    worker.on('error', lost);
    worker.on('exit', (code) => lost(new Error(`parser thread exited (code ${code})`)));

    this.slots.add(slot);
    this.idle.push(slot);
  }

  /**
   * Parse a batch on the next free worker.
   *
   * @param {Array<{rel: string, content: string, lang: object}>} items
   * @returns {Promise<Array<{extraction: object|null, error: string|null, skipped: string|null}>>}
   *   one result per item, in order. Rejects if the worker is lost.
   */
  run(items) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.slots.size) {
        reject(new Error('no parser threads available'));
        return;
      }
      this.queue.push({ items, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    while (this.idle.length && this.queue.length) {
      const slot = this.idle.pop();
      const job = this.queue.shift();
      slot.job = job;
      try {
        slot.worker.postMessage(job.items);
      } catch (err) {
        // Something in the batch could not be cloned. The worker is fine.
        slot.job = null;
        this.idle.push(slot);
        job.reject(err);
      }
    }
  }

  async close() {
    this.closed = true;
    const workers = [...this.slots].map((s) => s.worker);
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  }
}
