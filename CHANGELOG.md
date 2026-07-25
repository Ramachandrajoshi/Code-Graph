# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] — 2026-07-25
### Fixed

- **Indexing no longer fails on Node builds without SQLite FTS5.** FTS5 is a
  compile-time option and Node's bundled SQLite omits it in many builds
  (22.14 and 23.11 among them), so creating the full-text tables in a migration
  aborted startup entirely with `no such module: fts5`. Availability is now
  probed at runtime: with FTS5 the index uses it, without it search falls back
  to exact, prefix, trigram and substring matching over names, signatures and
  docs. `cgraph doctor` reports which mode is active, and a later upgrade to a
  Node that has FTS5 is picked up automatically and backfilled — no re-index.

## [0.1.0] — 2026-07-25

Initial release.

### Added

**Retrieval**
- `map` — hierarchical outline of a repo, directory, or file, replacing `ls`,
  `glob`, and exploratory reads.
- `find` — ranked symbol search across names, split identifier words,
  signatures, and documentation, replacing `grep`. Matches camelCase components
  (`login` finds `handleLogin`) and substrings.
- `read` — exactly one symbol or line range, replacing whole-file reads.
- `graph` — callers, callees, importers, transitive impact, and shortest call
  paths. No shell equivalent exists for this.
- `docs` — dependency APIs ranked by what the project actually calls, with
  in-repo usage sites.

**Indexing**
- Content-hash incremental updates; `touch` correctly changes nothing.
- `watch` mode via `fs.watch` with debouncing and coalescing.
- Full `.gitignore` semantics including nested files, negations, directory-only
  patterns, `.git/info/exclude`, and the global excludes file.
- Binary, minified, generated, and oversized files recorded as stubs rather than
  silently omitted.

**Graph quality**
- Every edge carries `EXACT` (proven through an import table or lexical scope)
  or `INFERRED` (name match). Unresolvable references are recorded rather than
  dropped.
- `doctor` reports resolution quality per language, so regressions are visible.
- Language runtime built-ins are classified rather than counted as failures.

**Languages**
- Deep packs with cross-file resolution: TypeScript, JavaScript, Python, Go,
  Rust, Java.
- 36 tree-sitter grammars detected and reported; grammars fetched on demand into
  a machine-wide cache and verified against pinned SHA-256 digests.

**Plugin system**
- Language packs discovered from builtins, `node_modules/cgraph-pack-*`,
  `~/.cgraph/packs/`, and `.cgraph/packs/`, in increasing precedence.
- `cgraph/sdk` with `definePack`, `validatePack`, and `makeTestContext`.
- `cgraph packs scaffold <lang>` generates a working pack.
- `core/` contains no language-specific knowledge.

**Integration**
- MCP server over stdio (JSON-RPC), auto-registered by `init` into `.mcp.json`,
  `.cursor/mcp.json`, `.vscode/mcp.json`, and `.windsurf/mcp.json`.
- Six MCP tools, budgeted to ~1.3k schema tokens, since tool schemas are a
  permanent per-turn cost.
- Programmatic API via `openProject()`.

**Optional**
- Embeddings behind an interface (Voyage, OpenAI), off by default; API keys read
  from the environment and never written to config.
- Language-server adapter for on-demand edge upgrades, never run during indexing.

**Verification**
- 231 tests over the real pipeline, real grammars, and real temporary
  repositories.
- `bench/` measures token reduction against a grep-then-read baseline; runs in
  CI so the central claim is defended rather than asserted.
- CI matrix across Windows, macOS, and Linux on Node 22.13, 22, and 24.

### Notes

- Requires Node >= 22.13, the first release with `node:sqlite` unflagged. No
  native compilation and no build step.
- `web-tree-sitter` is pinned to `~0.25.10`. The 0.26 line cannot load the
  grammars in `tree-sitter-wasms@0.1.13` and fails with an empty error message
  from inside the wasm loader. `test/grammars.test.js` gates any future bump.
- The `elm` and `ql` grammars are broken in that release and are refused with an
  explanatory message rather than an empty one.

[Unreleased]: https://github.com/Ramachandrajoshi/Code-Graph/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.1.1
[0.1.0]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.1.0
