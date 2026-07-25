/**
 * Minimal argument parsing.
 *
 * A dependency-free parser costs ~60 lines and removes a whole class of supply
 * chain and install-weight concerns from a tool whose selling point is that it
 * installs cleanly anywhere.
 */

/**
 * Parse `argv` into `{ _: positionals, ...flags }`.
 *
 * Supports `--flag`, `--no-flag`, `--key=value`, `--key value`, and `-abc`
 * short-flag clusters. `spec.strings` lists flags that always consume a value,
 * so `--path src` doesn't parse `src` as a positional.
 */
export function parseArgs(argv, spec = {}) {
  const strings = new Set(spec.strings ?? []);
  const numbers = new Set(spec.numbers ?? []);
  const alias = spec.alias ?? {};
  const out = { _: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      let value;

      const eq = key.indexOf('=');
      if (eq !== -1) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      }

      if (key.startsWith('no-') && value === undefined) {
        out[camel(key.slice(3))] = false;
        continue;
      }

      const name = camel(alias[key] ?? key);
      if (value === undefined) {
        if (strings.has(key) || strings.has(name) || numbers.has(key) || numbers.has(name)) {
          value = argv[++i];
        } else {
          value = true;
        }
      }
      out[name] = coerce(name, value, numbers);
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      const flags = arg.slice(1).split('');
      for (let j = 0; j < flags.length; j++) {
        const name = camel(alias[flags[j]] ?? flags[j]);
        const isLast = j === flags.length - 1;
        if (isLast && (strings.has(name) || numbers.has(name))) {
          out[name] = coerce(name, argv[++i], numbers);
        } else {
          out[name] = true;
        }
      }
      continue;
    }

    out._.push(arg);
  }

  return out;
}

function coerce(name, value, numbers) {
  if (value === undefined) return true;
  if (numbers.has(name)) {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`--${name} expects a number, got '${value}'`);
    return n;
  }
  return value;
}

function camel(s) {
  return String(s).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
