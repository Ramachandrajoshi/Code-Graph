/**
 * Output helpers.
 *
 * Default output is compact text, not JSON. This is a deliberate token decision:
 * JSON spends roughly 30-40% of its bytes on braces, quotes and repeated key
 * names, all of which the agent must pay for on every single response. `--json`
 * exists for programmatic consumers that need the structure.
 */

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;

const C = {
  reset: isTTY ? '\x1b[0m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
};

export const color = {
  dim: (s) => `${C.dim}${s}${C.reset}`,
  bold: (s) => `${C.bold}${s}${C.reset}`,
  red: (s) => `${C.red}${s}${C.reset}`,
  green: (s) => `${C.green}${s}${C.reset}`,
  yellow: (s) => `${C.yellow}${s}${C.reset}`,
  cyan: (s) => `${C.cyan}${s}${C.reset}`,
};

export function out(line = '') {
  process.stdout.write(line + '\n');
}

export function json(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function warn(line) {
  process.stderr.write(color.yellow('warn: ') + line + '\n');
}

/** Human-readable byte count. */
export function bytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

/** Compact token count: 1234 -> '1.2k'. */
export function toks(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function duration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** Right-pad to a column width, for aligned tabular text output. */
export function pad(s, width) {
  s = String(s);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

export function padLeft(s, width) {
  s = String(s);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/** Simple progress reporter that stays quiet when output is piped. */
export class Progress {
  constructor(label, { quiet = false } = {}) {
    this.label = label;
    this.quiet = quiet || !isTTY;
    this.n = 0;
    this.last = 0;
  }

  tick(n = 1, detail = '') {
    this.n += n;
    if (this.quiet) return;
    const now = Date.now();
    if (now - this.last < 80) return; // Throttle: redraw cost adds up on big repos.
    this.last = now;
    const line = `${this.label} ${this.n}${detail ? ' ' + color.dim(detail) : ''}`;
    process.stderr.write('\r\x1b[K' + line.slice(0, (process.stderr.columns ?? 80) - 1));
  }

  done(summary) {
    if (!this.quiet) process.stderr.write('\r\x1b[K');
    if (summary) process.stderr.write(summary + '\n');
  }
}
