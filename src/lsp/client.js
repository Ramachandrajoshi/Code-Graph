/**
 * Language server adapter — optional precision upgrade.
 *
 * A language server knows things tree-sitter cannot: it resolves types, follows
 * inheritance, and understands duck-typed calls like `ctx.hasFile(...)` that
 * this tool's resolver correctly refuses to guess about. Consulting one turns
 * an INFERRED edge into an EXACT one.
 *
 * Two deliberate constraints:
 *
 *   1. NEVER during bulk indexing. Starting five language servers to index a
 *      monorepo costs gigabytes of RAM and minutes of warm-up, which would
 *      destroy the fast-index property the whole tool depends on.
 *   2. Lazy and on demand. A server starts only when a query explicitly asks
 *      for an exactness upgrade, and the answer is cached in the graph so the
 *      cost is paid once.
 *
 * Framing note: LSP uses Content-Length headers, NOT the newline-delimited JSON
 * that MCP uses. These are different protocols that both speak JSON-RPC.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export class LspClient {
  constructor({ command, args = [], root, name = command }) {
    this.command = command;
    this.args = args;
    this.root = root;
    this.name = name;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.ready = null;
    this.openDocuments = new Set();
  }

  /** Start the server and complete the LSP handshake. Idempotent. */
  start() {
    if (this.ready) return this.ready;

    this.ready = (async () => {
      try {
        this.child = spawn(this.command, this.args, {
          cwd: this.root,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        throw new Error(`Cannot start language server '${this.command}': ${err.message}`);
      }

      this.child.on('error', (err) => this._failAll(err));
      this.child.stdout.on('data', (chunk) => this._onData(chunk));
      // Language servers are chatty on stderr; discard rather than interleave it
      // with our own diagnostics.
      this.child.stderr.resume();

      await this._request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }],
        capabilities: {
          textDocument: {
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            hover: { contentFormat: ['plaintext'] },
          },
        },
      });
      this._notify('initialized', {});
      return true;
    })();

    return this.ready;
  }

  /**
   * Resolve the definition of the symbol at a position.
   * Returns `{ path, line }` in repo-relative POSIX form, or null.
   */
  async definition(relPath, line, character) {
    await this.start();
    const uri = pathToFileURL(path.join(this.root, relPath)).href;
    await this._ensureOpen(relPath, uri);

    const result = await this._request('textDocument/definition', {
      textDocument: { uri },
      position: { line: line - 1, character },   // LSP is 0-based; we are 1-based
    });

    const first = Array.isArray(result) ? result[0] : result;
    if (!first) return null;

    const targetUri = first.uri ?? first.targetUri;
    const range = first.range ?? first.targetSelectionRange ?? first.targetRange;
    if (!targetUri || !range) return null;

    const abs = fileURLToPath(targetUri);
    const rel = path.relative(this.root, abs).split(path.sep).join('/');
    if (rel.startsWith('..')) return null;   // outside the repo: a dependency

    return { path: rel, line: range.start.line + 1 };
  }

  async _ensureOpen(relPath, uri) {
    if (this.openDocuments.has(uri)) return;
    const fs = await import('node:fs');
    let text = '';
    try {
      text = fs.readFileSync(path.join(this.root, relPath), 'utf8');
    } catch {
      return;
    }
    this._notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'typescript', version: 1, text },
    });
    this.openDocuments.add(uri);
  }

  stop() {
    if (!this.child) return;
    try {
      this._notify('exit', {});
      this.child.kill();
    } catch {
      // Already gone.
    }
    this.child = null;
    this.ready = null;
    this._failAll(new Error('language server stopped'));
  }

  // -- transport -------------------------------------------------------------

  _request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      // A hung language server must not hang the agent's query. Failing here
      // degrades to the tree-sitter answer, which is the correct fallback.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`language server '${this.name}' timed out on ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
    });

    this._send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  _notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  _send(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    // LSP framing: Content-Length header, blank line, then the JSON body.
    this.child?.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child?.stdin.write(body);
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {   // Unparseable header: resync rather than spin forever.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;   // await the rest

      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);

      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }

      const entry = this.pending.get(message.id);
      if (!entry) continue;   // a server-initiated request or a notification
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  }

  _failAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }
}

/**
 * Upgrade INFERRED edges for one file using a language server.
 *
 * Scoped to a single file on purpose: this is a targeted operation an agent
 * invokes when it needs certainty about specific code, not a background job.
 * Results are written back as EXACT so the cost is paid once.
 */
export async function upgradeFile(store, config, registry, relPath, { limit = 40 } = {}) {
  const file = store.getFileByPath(relPath);
  if (!file) throw new Error(`No indexed file '${relPath}'`);

  const pack = registry.packFor(file.lang);
  if (!pack?.lsp) {
    return { upgraded: 0, reason: `no language server configured for ${file.lang}` };
  }

  const client = new LspClient({
    command: pack.lsp.command,
    args: pack.lsp.args ?? [],
    root: config.root,
    name: pack.lsp.command,
  });

  const inferred = store.all(
    `SELECT e.id, e.line, n.name FROM edges e
       JOIN nodes n ON n.id = e.dst_id
      WHERE e.file_id = ? AND e.confidence = 'INFERRED' LIMIT ?`,
    file.id, limit
  );

  let upgraded = 0;
  try {
    await client.start();

    for (const edge of inferred) {
      const target = await client.definition(relPath, edge.line, 0).catch(() => null);
      if (!target) continue;

      const targetFile = store.getFileByPath(target.path);
      if (!targetFile) continue;

      const node = store.get(
        `SELECT id FROM nodes WHERE file_id = ? AND start_line <= ? AND end_line >= ?
          ORDER BY (end_line - start_line) ASC LIMIT 1`,
        targetFile.id, target.line, target.line
      );
      if (!node) continue;

      store.run("UPDATE edges SET dst_id = ?, confidence = 'EXACT' WHERE id = ?", node.id, edge.id);
      upgraded++;
    }
  } catch (err) {
    return { upgraded, error: err.message };
  } finally {
    client.stop();
  }

  return { upgraded, considered: inferred.length };
}
