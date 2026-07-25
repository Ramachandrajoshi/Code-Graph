/**
 * Minimal MCP transport: JSON-RPC 2.0 over newline-delimited stdio.
 *
 * Written directly rather than pulling in the MCP SDK. The whole premise of
 * this tool is that it installs cleanly anywhere with no build step, and the
 * protocol surface we need — initialize, tools/list, tools/call — is small
 * enough that a dependency would cost more than it saves.
 *
 * Framing note: MCP stdio uses newline-delimited JSON, NOT the Content-Length
 * headers that LSP uses. Getting this wrong produces a server that connects and
 * then silently never responds.
 */

import { createInterface } from 'node:readline';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** JSON-RPC error codes we emit. */
export const ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

export class StdioServer {
  constructor({ name, version, handlers }) {
    this.name = name;
    this.version = version;
    this.handlers = handlers;
    this.initialized = false;
  }

  /** Start reading requests. Resolves when stdin closes. */
  start() {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, terminal: false });

      rl.on('line', (line) => {
        const text = line.trim();
        if (!text) return;
        // Each line is handled independently and errors are contained: one bad
        // request must not kill a long-lived session.
        this._handleLine(text).catch((err) => this._logError(err));
      });

      rl.on('close', resolve);
    });
  }

  async _handleLine(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return this._send({ jsonrpc: '2.0', id: null, error: { code: ERRORS.PARSE, message: 'Parse error' } });
    }

    if (message.jsonrpc !== '2.0') {
      return this._send({
        jsonrpc: '2.0', id: message.id ?? null,
        error: { code: ERRORS.INVALID_REQUEST, message: 'Expected jsonrpc 2.0' },
      });
    }

    // Notifications carry no id and must never receive a response — replying to
    // one is a protocol violation that some clients treat as fatal.
    const isNotification = message.id === undefined || message.id === null;

    try {
      const result = await this._dispatch(message);
      if (!isNotification) {
        this._send({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
      }
    } catch (err) {
      if (isNotification) return this._logError(err);
      this._send({
        jsonrpc: '2.0', id: message.id,
        error: { code: err.code ?? ERRORS.INTERNAL, message: err.message },
      });
    }
  }

  async _dispatch(message) {
    const { method, params } = message;

    switch (method) {
      case 'initialize': {
        // Echo the client's version when we speak it; otherwise offer our newest
        // and let the client decide whether it can proceed.
        const requested = params?.protocolVersion;
        const version = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        this.initialized = true;
        return {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.name, version: this.version },
        };
      }

      case 'notifications/initialized':
      case 'initialized':
        return null;

      case 'ping':
        return {};

      case 'tools/list':
        return { tools: await this.handlers.listTools() };

      case 'tools/call': {
        const name = params?.name;
        if (!name) {
          throw Object.assign(new Error('tools/call requires a name'), { code: ERRORS.INVALID_PARAMS });
        }
        return await this.handlers.callTool(name, params.arguments ?? {});
      }

      // Declared unsupported explicitly. Returning empty lists is friendlier
      // than METHOD_NOT_FOUND for clients that probe capabilities.
      case 'resources/list':
        return { resources: [] };
      case 'prompts/list':
        return { prompts: [] };

      default:
        throw Object.assign(new Error(`Unknown method: ${method}`), { code: ERRORS.METHOD_NOT_FOUND });
    }
  }

  _send(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
  }

  /**
   * Diagnostics go to stderr, never stdout: stdout is the protocol channel and
   * a stray log line there corrupts the stream and disconnects the client.
   */
  _logError(err) {
    process.stderr.write(`[code-graph] ${err?.stack ?? err}\n`);
  }
}

/** Wrap plain text as an MCP tool result. */
export function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

/** Wrap an error as a tool result the model can read and react to. */
export function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
