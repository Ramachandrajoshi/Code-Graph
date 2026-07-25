/**
 * `cgraph packs` — inspect, scaffold, and diagnose language packs.
 *
 * The plugin system is only real if authoring a pack is easy, so `scaffold`
 * generates a working pack rather than an empty template.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, userCacheDir } from '../../core/config.js';
import { PackRegistry } from '../../packs/registry.js';
import { LANGUAGES, languageById } from '../../packs/languages.js';
import { KNOWN_GRAMMARS, grammarInfo, localGrammars } from '../../core/grammars.js';
import { out, json, color, pad, padLeft } from '../ui.js';

export async function run(args) {
  if (args.help) return help();

  const sub = args._[0] ?? 'list';
  const config = loadConfig(process.cwd(), args.root ? { root: args.root } : {});

  switch (sub) {
    case 'list':     return listPacks(config, args);
    case 'scaffold': return scaffold(config, args);
    case 'where':    return where(config);
    default:
      throw new Error(`unknown subcommand '${sub}'. Use: list, scaffold, where`);
  }
}

async function listPacks(config, args) {
  const registry = await PackRegistry.load(config);
  try {
    const local = localGrammars();
    const rows = [];

    for (const lang of LANGUAGES) {
      const pack = registry.packs.get(lang.id);
      const info = grammarInfo(lang.grammar);
      const queries = pack ? Object.keys(registry.queriesFor(lang.id)) : [];

      rows.push({
        language: lang.id,
        grammar: lang.grammar,
        pack: pack?.id ?? null,
        origin: pack?._origin ?? null,
        queries,
        grammarState: info?.abiOk === false ? 'incompatible'
          : local.has(lang.grammar) ? local.get(lang.grammar)
          : 'on demand',
        extracts: queries.includes('tags'),
      });
    }

    if (args.json) return json(rows);

    out('');
    out(color.bold('language packs'));
    out(color.dim(`  ${pad('language', 12)} ${pad('pack', 14)} ${pad('grammar', 12)} extraction`));

    for (const r of rows) {
      const state = r.extracts
        ? color.green('symbols + edges')
        : r.grammarState === 'incompatible'
          ? color.red('grammar unusable')
          : color.dim('detected only');
      out(`  ${pad(r.language, 12)} ${pad(r.pack ?? '—', 14)} ${pad(r.grammarState, 12)} ${state}`);
    }

    const withQueries = rows.filter((r) => r.extracts).length;
    out('');
    out(color.dim(
      `  ${withQueries} of ${rows.length} languages extract symbols; ` +
      `the rest are detected and listed but contribute no graph data.`
    ));
    out(color.dim('  add a pack with `cgraph packs scaffold <language>`'));
    out('');
  } finally {
    registry.dispose();
  }
}

/**
 * Generate a working pack for a language.
 *
 * Writes to `.cgraph/packs/<id>/`, which the registry discovers with the
 * highest precedence — so a scaffolded pack overrides a builtin immediately,
 * with no install step and no fork.
 */
function scaffold(config, args) {
  const id = args._[1];
  if (!id) throw new Error('packs scaffold: give a language id, e.g. `cgraph packs scaffold go`');

  const known = languageById(id);
  const grammar = args.grammar ?? known?.grammar ?? id;

  if (!grammarInfo(grammar) && !args.grammar) {
    throw new Error(
      `No grammar named '${grammar}'.\n` +
        `Known grammars: ${KNOWN_GRAMMARS.join(', ')}\n` +
        'Pass --grammar <name> to override.'
    );
  }

  const dir = path.join(config.dir, 'packs', id);
  if (fs.existsSync(dir) && !args.force) {
    throw new Error(`${dir} already exists. Pass --force to overwrite.`);
  }

  fs.mkdirSync(path.join(dir, 'queries'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), packTemplate(id, grammar, known));

  // Packs are ES modules. Without this marker Node re-parses index.js as
  // CommonJS, fails, retries as ESM, and prints a MODULE_TYPELESS_PACKAGE_JSON
  // warning every time the pack loads — noise the author did not cause and
  // cannot easily explain.
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: `cgraph-pack-${id}`, version: '0.1.0', type: 'module', private: true }, null, 2) + '\n'
  );
  fs.writeFileSync(path.join(dir, 'queries', 'tags.scm'), tagsTemplate(id));
  fs.writeFileSync(path.join(dir, 'queries', 'imports.scm'), importsTemplate(id));

  out('');
  out(`${color.green('created')} ${path.relative(config.root, dir)}`);
  out('');
  out('  next:');
  out(`    1. edit ${color.cyan('queries/tags.scm')} — node names must match the ${grammar} grammar`);
  out(`    2. run ${color.cyan('cgraph index --force')} to apply it`);
  out(`    3. run ${color.cyan('cgraph doctor')} to see the resolution quality it achieves`);
  out('');
  out(color.dim('  tip: upstream tree-sitter grammar repos ship a queries/tags.scm'));
  out(color.dim('       that can usually be dropped in with minimal edits.'));
  out('');
}

function where(config) {
  out('');
  out(color.bold('pack discovery order') + color.dim('  (later overrides earlier)'));
  out('');
  out(`  1  builtin        ${color.dim('shipped with cgraph')}`);
  out(`  2  ${path.join(config.root, 'node_modules', 'cgraph-pack-*')}`);
  out(`  3  ${path.join(userCacheDir(), 'packs')}`);
  out(`  4  ${path.join(config.dir, 'packs')}  ${color.dim('highest precedence')}`);
  out('');
}

function packTemplate(id, grammar, known) {
  return `/**
 * ${id} language pack.
 *
 * Every hook below is optional — delete what you do not need and core falls
 * back to generic behaviour. Only \`id\`, \`languages\` and \`queries.tags\` are
 * required for symbol extraction.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: '${id}',
  languages: ['${id}'],
  extensions: ${JSON.stringify(known?.ext ?? [`.${id}`])},

  queries: {
    tags: path.join(here, 'queries', 'tags.scm'),
    imports: path.join(here, 'queries', 'imports.scm'),
  },

  /** Should this pack load for this repo? Return false to skip it entirely. */
  detect(ctx) {
    return true;
  },

  /**
   * Compact one-line signature. The generic fallback takes the first physical
   * line, which truncates multi-line parameter lists — override if that matters
   * for this language.
   */
  // signature(def, source) { return null; },

  /** Documentation attached to a definition. */
  // docComment(def, source) { return null; },

  /** Is this symbol part of the module's public API? */
  // isExported(def, source) { return true; },

  /**
   * Resolve an import specifier to a repo-relative path, or classify it as an
   * external dependency. This is what turns INFERRED edges into EXACT ones, so
   * it is the highest-value hook to implement.
   */
  // resolveImport(spec, fromPath, ctx) {
  //   if (ctx.hasFile(spec + '.${id}')) return { file: spec + '.${id}' };
  //   return { external: { ecosystem: '${id}', package: spec.split('/')[0] } };
  // },

  /**
   * Language runtime names. Without these, calls like list.append() are
   * reported as unresolved and swamp the resolution-quality metric.
   */
  // builtins: { globals: new Set([]), methods: new Set([]), package: '${id}' },
};
`;
}

function tagsTemplate(id) {
  return `; ${id} definitions and references.
;
; Capture vocabulary:
;   @definition.<kind>  the whole construct — its byte range becomes the node
;   @name               the identifier naming it
;   @reference.<kind>   a use of some symbol
;   @receiver           the object part of a member call, used for resolution
;
; CRITICAL: attach @definition to the declaration itself, never to an enclosing
; (program) or (module) node. A capture on the file root gives the symbol the
; byte range of the entire file, which makes every later definition its child
; and silently corrupts the hierarchy.
;
; Run \`cgraph index --force\` after editing; a node name the grammar does not
; know fails the whole query to compile, and the error names this file.

; (function_definition
;   name: (identifier) @name) @definition.function

; (class_definition
;   name: (identifier) @name) @definition.class

; (call
;   function: (identifier) @name) @reference.call
`;
}

function importsTemplate(id) {
  return `; ${id} imports.
;
; Capture @source for the module specifier, @symbol for a named import, and
; @alias for the local binding. Each bound name should produce one row.

; (import_statement
;   source: (string) @source) @import
`;
}

function help() {
  out(`
${color.bold('cgraph packs')} — inspect and author language packs

  cgraph packs list                 Which languages extract symbols
  cgraph packs scaffold <lang>      Generate a pack in .cgraph/packs/
  cgraph packs where                Discovery paths, in precedence order

${color.bold('OPTIONS')}
  --grammar <name>   Grammar to bind (default: same as the language id)
  --force            Overwrite an existing scaffold
  --json             Machine-readable output
`);
}
