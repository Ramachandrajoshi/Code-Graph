# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.3] — 2026-07-26
## [0.2.2] — 2026-07-26
## [0.2.1] — 2026-07-26
### Fixed
- Bug fixes from GitHub issues.

## [0.2.0] — 2026-07-25
### Added
- **Dependency docs are fetched when not installed locally.** Every registry
  publishes the same artifact cgraph reads off disk, so it is downloaded and run
  through the same parsers: npm `.tgz` (falling back to `@types/<pkg>`, since a
  large share of npm ships no types of its own), NuGet `.nupkg`, Maven
  `-sources.jar`, PyPI wheels. No scraping and no third-party service — the
  result is version-exact because it is the published artifact.
- **Maven dependency docs**, local and remote, now that a zip reader exists.
- `cgraph docs --refresh --guides` fetches [`llms.txt`](https://llmstxt.org)
  where a project publishes one. Package archives carry API reference because
  that is what is in the source; they cannot carry setup guides, which were
  never in the source. This is the only prose source, and coverage is partial.
- tar.gz and zip readers built on `node:zlib`, with no new dependencies.
- **C# language pack.** Types, members, properties, namespaces, XML doc
  summaries and access modifiers, with `using` resolved to the file declaring
  that namespace. LINQ and BCL calls are classified as runtime built-ins rather
  than swamping the unresolved list.
- **Project technology discovery.** Manifests (`*.csproj`, `package.json`,
  `pom.xml`, `pyproject.toml`, `go.mod`, `Cargo.toml`, …) are read before any
  parsing, so only the packs a project actually needs are loaded and only their
  grammars are fetched. Frameworks — Angular, React, ASP.NET, Entity Framework,
  Spring, Django, FastAPI — are detected from every manifest in the tree, not
  just the root. A file in an unpredicted language still loads its pack on
  sight: discovery decides what loads eagerly, never what gets ignored.
- **.NET dependency documentation.** NuGet ships compiled assemblies, so there
  is no source to parse — but packages carry an XML documentation file beside
  the DLL with every public member and its summary. `docs` now reads it,
  preferring the newest target framework present.
- **Local embedding models.** `provider: "local"` targets any OpenAI-compatible
  endpoint (Ollama, LM Studio, llama.cpp, vLLM) with `baseUrl`, `model` and
  optional `dimensions`. Nothing leaves the machine and nothing costs money. The
  returned vector width is verified against `dimensions` on the first batch,
  because a silent mismatch corrupts every similarity score in a way that is
  close to untraceable.
- **The index refreshes itself.** The MCP server checks for changes before
  answering, so an agent never reads a graph that disagrees with the working
  tree — after an editor save, a git checkout, a rebase, or another agent's
  edit. No watcher, no hook, nothing to remember. Throttled (3s) so a burst of
  tool calls costs one scan, and disabled with
  `autoRefresh.enabled: false`.
- `cgraph hooks install` — pre-warms the index after checkout, merge and
  rebase, the operations that change hundreds of files at once. Appends between
  markers and never replaces an existing hook; backgrounded so it cannot delay
  a git command. `post-commit` is excluded by default because committing does
  not change the working tree.
- `cgraph init --agent` for Claude Code, GitHub Copilot, opencode, Cursor and
  Windsurf, writing both the MCP registration and an instruction block telling
  the agent to use these tools instead of grep.

### Changed

- **No token-savings multiplier is published any more.** The previous figures
  compared cgraph against an invented grep-then-read baseline: an agent opens
  every file grep matched, capped at ten, and reads each whole. No agent was
  ever run. Change the cap, assume line windows instead of whole files, or
  assume two probes instead of one, and the ratio moves by an order of
  magnitude — the assumption determined the number, not the measurement.
  Responses now report their own size, and where a concrete comparable exists
  (the file an outline describes) both numbers are shown as facts with no
  arithmetic between them. `bench/` remains as a regression guard on response
  sizes, comparable only to itself.
- **Freshness checks no longer read the repository.** A file whose size and
  mtime match the index is skipped without being opened; only files that fail
  that check are read and hashed. On llama.cpp a no-op pass drops from ~520ms
  to ~170ms, which is what makes automatic refresh affordable. The content hash
  still decides, so a file touched but not edited is read once and correctly not
  re-parsed.

### Breaking

- `SavingsLedger` is renamed `UsageLedger` in the programmatic API, and records
  `tokens_returned` / `tokens_source` instead of `tokens_baseline` /
  `tokens_saved`. The old name asserted a saving the tool cannot observe. Only
  affects code importing it from `cgraph`; the CLI and MCP surfaces are
  unchanged.
- `cgraph stats` no longer prints a reduction factor, and `cgraph doctor` no
  longer prints "tokens saved". Anything parsing that output needs updating.

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
- `bench/` measures response sizes across typical questions, so output bloat
  shows up as a regression. It deliberately reports no savings multiplier.
- CI matrix across Windows, macOS, and Linux on Node 22.13, 22, and 24.

### Notes

- Requires Node >= 22.13, the first release with `node:sqlite` unflagged. No
  native compilation and no build step.
- `web-tree-sitter` is pinned to `~0.25.10`. The 0.26 line cannot load the
  grammars in `tree-sitter-wasms@0.1.13` and fails with an empty error message
  from inside the wasm loader. `test/grammars.test.js` gates any future bump.
- The `elm` and `ql` grammars are broken in that release and are refused with an
  explanatory message rather than an empty one.

[Unreleased]: https://github.com/Ramachandrajoshi/Code-Graph/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.2.3
[0.2.2]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.2.2
[0.2.0]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.2.0
[0.1.1]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.1.1
[0.1.0]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.1.0
