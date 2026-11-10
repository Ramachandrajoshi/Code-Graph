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

/** Thousands separators: 128450 -> '128,450'. */
export function count(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const BAR_WIDTH = 20;

function bar(fraction) {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * BAR_WIDTH);
  return color.cyan('█'.repeat(filled)) + color.dim('░'.repeat(BAR_WIDTH - filled));
}

/**
 * Single-line progress reporter that stays quiet when output is piped.
 *
 * A long job is reported as a sequence of named phases. A phase that knows its
 * size up front draws a bar with a percentage, a rate and a time estimate; one
 * that does not just counts. The distinction matters on a large repository: a
 * bare counter climbing past 40,000 says the tool is alive but not whether to
 * wait or go for lunch, and a silent gap between phases reads as a hang.
 */
export class Progress {
  constructor(label, { quiet = false } = {}) {
    // Leading whitespace is the caller's indentation and is kept for every
    // phase, so the line stays aligned with the report printed after it.
    this.indent = label.match(/^\s*/)[0];
    this.label = label.trim();
    this.quiet = quiet || !process.stderr.isTTY || !isTTY;
    this.n = 0;
    this.total = 0;
    this.work = 0;
    this.workDone = 0;
    this.started = Date.now();
    this.last = 0;
  }

  /**
   * Begin a named phase.
   *
   * @param {string} label
   * @param {object} [size]
   * @param {number} [size.total] how many items `tick` will count, if known
   * @param {number} [size.work]  total of the `work` amounts `tick` will report;
   *   the bar tracks this rather than the item count, because items are rarely
   *   the same size (a file skipped on its stat is not a file that is parsed)
   */
  phase(label, { total = 0, work = 0 } = {}) {
    this.label = label;
    this.n = 0;
    this.total = total;
    this.work = work;
    this.workDone = 0;
    this.started = Date.now();
    this.detail = '';
    this._draw(true);
  }

  tick(n = 1, detail = '', work = 0) {
    this.n += n;
    this.workDone += work;
    this.detail = detail;
    this._draw(false);
  }

  /** Report absolute progress, for a phase that counts its own work. */
  update(done, total) {
    this.n = done;
    this.total = total;
    this.work = total;
    this.workDone = done;
    this.detail = '';
    this._draw(false);
  }

  _draw(force) {
    if (this.quiet) return;
    const now = Date.now();
    if (!force && now - this.last < 80) return; // Throttle: redraw cost adds up on big repos.
    this.last = now;

    let line = `${this.indent}${pad(this.label, 9)} `;
    let visible = line.length;
    const add = (text, shown = text.length) => { line += text; visible += shown; };

    if (this.work > 0) {
      const fraction = Math.min(1, this.workDone / this.work);
      add(bar(fraction), BAR_WIDTH);
      add(` ${padLeft(Math.floor(fraction * 100), 3)}%  ${count(this.n)}/${count(this.total)}`);

      const elapsed = (now - this.started) / 1000;
      if (elapsed >= 1) {
        add(`  ·  ${count(this.n / elapsed)}/s`);
        // An estimate from the first few percent swings wildly; say nothing
        // until there is enough history for it to mean something.
        if (fraction >= 0.05 && fraction < 1) {
          add(`  ·  ~${duration((elapsed * (1 - fraction) / fraction) * 1000)} left`);
        }
      }
    } else if (this.n > 0) {
      add(count(this.n));
    }

    // Whatever room is left goes to the detail, cut from the left: the end of
    // a path is the part that identifies the file.
    const room = (process.stderr.columns ?? 80) - 1 - visible - 2;
    if (this.detail && room >= 8) {
      const d = this.detail.length > room ? '…' + this.detail.slice(this.detail.length - room + 1) : this.detail;
      line += '  ' + color.dim(d);
    }

    process.stderr.write('\r\x1b[K' + line);
  }

  done(summary) {
    if (!this.quiet) process.stderr.write('\r\x1b[K');
    if (summary) process.stderr.write(summary + '\n');
  }
}

/**
 * One line saying where an index run spent its time, e.g.
 * `scan 0.4s · parse 6.1s (8 threads) · resolve 0.9s · rank 0.2s`.
 * Phases too short to matter are left out.
 */
export function phaseSummary(stats) {
  const p = stats.phases;
  if (!p) return '';
  const parts = [];
  if (p.scan >= 100) parts.push(`scan ${duration(p.scan)}`);
  if (p.index >= 100) {
    parts.push(`parse ${duration(p.index)}${stats.workers > 1 ? ` (${stats.workers} threads)` : ''}`);
  }
  if (p.resolve >= 100) parts.push(`resolve ${duration(p.resolve)}`);
  if (p.rank >= 100) parts.push(`rank ${duration(p.rank)}`);
  return parts.join('  ·  ');
}
