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

  // One source of truth for "does this flag consume the next argv as its value".
  // Specs list the alias KEY (e.g. 'q') in `strings`/`numbers`, not the resolved
  // name ('query'), so a flag consumes a value when EITHER its raw form OR its
  // resolved alias name is declared. The long and short branches MUST share this
  // check: when only the long branch consulted the raw key, `-q foo` resolved the
  // name to 'query', missed the 'q' entry, and silently dropped the value into
  // positionals while `--q foo` worked — the two forms drifted.
  const consumesValue = (raw, name) =>
    strings.has(raw) || strings.has(name) || numbers.has(raw) || numbers.has(name);

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
        if (consumesValue(key, name)) {
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
        // Cluster semantics: only the last char of `-abc` may consume a value,
        // so a boolean cluster like `-jq` stays two booleans and never swallows
        // the next argv.
        const isLast = j === flags.length - 1;
        if (isLast && consumesValue(flags[j], name)) {
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
