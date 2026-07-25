/**
 * Language table: how a file path maps to a grammar.
 *
 * This is data, not logic, and it is deliberately separate from the packs
 * themselves. Detection works for every grammar in the manifest the moment it is
 * listed here, even before anyone writes extraction queries for it — so `map`
 * can always tell an agent "this is a Kotlin file" rather than "unknown".
 *
 * `grammar` is the tree-sitter grammar name (the .wasm basename).
 */

export const LANGUAGES = [
  { id: 'typescript', grammar: 'typescript', ext: ['.ts', '.mts', '.cts'] },
  { id: 'tsx',        grammar: 'tsx',        ext: ['.tsx'] },
  { id: 'javascript', grammar: 'javascript', ext: ['.js', '.mjs', '.cjs', '.jsx'] },
  { id: 'python',     grammar: 'python',     ext: ['.py', '.pyi', '.pyw'] },
  { id: 'go',         grammar: 'go',         ext: ['.go'] },
  { id: 'rust',       grammar: 'rust',       ext: ['.rs'] },
  { id: 'java',       grammar: 'java',       ext: ['.java'] },
  { id: 'c',          grammar: 'c',          ext: ['.c', '.h'] },
  { id: 'cpp',        grammar: 'cpp',        ext: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.c++'] },
  { id: 'csharp',     grammar: 'c_sharp',    ext: ['.cs'] },
  { id: 'ruby',       grammar: 'ruby',       ext: ['.rb', '.rake', '.gemspec'], filenames: ['Rakefile', 'Gemfile'] },
  { id: 'php',        grammar: 'php',        ext: ['.php'] },
  { id: 'swift',      grammar: 'swift',      ext: ['.swift'] },
  { id: 'kotlin',     grammar: 'kotlin',     ext: ['.kt', '.kts'] },
  { id: 'scala',      grammar: 'scala',      ext: ['.scala', '.sc'] },
  { id: 'lua',        grammar: 'lua',        ext: ['.lua'] },
  { id: 'bash',       grammar: 'bash',       ext: ['.sh', '.bash', '.zsh'], shebangs: ['sh', 'bash', 'zsh'] },
  { id: 'elixir',     grammar: 'elixir',     ext: ['.ex', '.exs'] },
  { id: 'elm',        grammar: 'elm',        ext: ['.elm'] },
  { id: 'dart',       grammar: 'dart',       ext: ['.dart'] },
  { id: 'zig',        grammar: 'zig',        ext: ['.zig'] },
  { id: 'ocaml',      grammar: 'ocaml',      ext: ['.ml', '.mli'] },
  { id: 'objc',       grammar: 'objc',       ext: ['.m', '.mm'] },
  { id: 'solidity',   grammar: 'solidity',   ext: ['.sol'] },
  { id: 'vue',        grammar: 'vue',        ext: ['.vue'] },
  { id: 'rescript',   grammar: 'rescript',   ext: ['.res', '.resi'] },
  { id: 'elisp',      grammar: 'elisp',      ext: ['.el'] },
  { id: 'ql',         grammar: 'ql',         ext: ['.ql', '.qll'] },
  { id: 'tlaplus',    grammar: 'tlaplus',    ext: ['.tla'] },
  { id: 'systemrdl',  grammar: 'systemrdl',  ext: ['.rdl'] },

  // Config and markup. Worth indexing: an agent asking "where is the build
  // configured" should get an answer, and these files are small.
  { id: 'json',       grammar: 'json',       ext: ['.json', '.jsonc'] },
  { id: 'yaml',       grammar: 'yaml',       ext: ['.yaml', '.yml'] },
  { id: 'toml',       grammar: 'toml',       ext: ['.toml'] },
  { id: 'html',       grammar: 'html',       ext: ['.html', '.htm'] },
  { id: 'css',        grammar: 'css',        ext: ['.css', '.scss', '.sass', '.less'] },
  { id: 'erb',        grammar: 'embedded_template', ext: ['.erb', '.ejs'] },
];

const BY_EXT = new Map();
const BY_FILENAME = new Map();
const BY_SHEBANG = new Map();
const BY_ID = new Map();

for (const lang of LANGUAGES) {
  BY_ID.set(lang.id, lang);
  for (const e of lang.ext ?? []) {
    // First listed language wins a contested extension. `.h` is C rather than
    // C++ because the C grammar parses both acceptably, while the reverse is
    // not true for plain C headers.
    if (!BY_EXT.has(e)) BY_EXT.set(e, lang);
  }
  for (const f of lang.filenames ?? []) BY_FILENAME.set(f, lang);
  for (const s of lang.shebangs ?? []) BY_SHEBANG.set(s, lang);
}

export function languageById(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Detect a language from path and (optionally) content.
 * Extension first, then exact filename, then shebang.
 */
export function detectLanguage(relPath, content) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);

  const byName = BY_FILENAME.get(base);
  if (byName) return byName;

  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const byExt = BY_EXT.get(base.slice(dot).toLowerCase());
    if (byExt) return byExt;
  }

  if (content && content.startsWith('#!')) {
    const first = content.slice(0, 200).split('\n')[0];
    // Handles both `#!/bin/bash` and `#!/usr/bin/env python3`.
    const interpreter = first.split(/[\s/]+/).filter(Boolean).pop() ?? '';
    const normalized = interpreter.replace(/[0-9.]+$/, '');
    const byShebang = BY_SHEBANG.get(normalized) ?? BY_ID.get(normalized);
    if (byShebang) return byShebang;
  }

  return null;
}
