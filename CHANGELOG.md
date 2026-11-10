# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Search
- **`find` answers questions, not just name lookups.** It used to score each
  matching strategy separately and add the results, which works when the query
  is a name and fails when it is a description: a function about all of
  "retry failed upload" lost to sixty symbols with "upload" in their name.
  Every candidate is now scored against the whole query — each word credited
  once, for the most telling place it appears, weighted by how rare it is in
  the repository — and scaled by how much of the query it matched. Measured
  with `npm run bench:search` on llama.cpp, the function a query was built
  from is in the top five:
  - from four words of its doc comment: 22% → 99%
  - from three identifiers used in its body: 3% → 73%
- **Function bodies are searchable.** The words a function uses — the helpers
  it calls, the fields it touches, the words in its messages — are indexed,
  so code can be found by what it does. An identifier that is used but never
  defined in the index is answered with the functions that use it. This is a
  sixth column in the full-text index; an existing index is rebuilt once,
  automatically. Index time and size are within a few percent of before.
- **Quoted text is searched literally**, and each matching line is reported
  under the symbol that contains it, with that symbol's line range —
  `find '"connection refused"'`. A query that matches no symbol is tried as
  text before giving up. This closes the case that still sent agents to grep:
  strings, comments, config keys, and files in languages without queries.
  Smart case; 0.35s across 178 MB on llama.cpp.
- **Responses are 75–85% smaller.** Measured on the same questions:

  | | before | after |
  |---|---|---|
  | `find` an exact name, llama.cpp | 1,351 tok | 297 tok |
  | `find` an exact name, this repo | 728 tok | 105 tok |

  Three changes. A hit printed its file path twice, once inside the qualified
  name and once in the location; it is now `path:start-end  kind Name`, and
  the same goes for caller, callee and impact lists. Locations are line
  *ranges*, so the definition can be read without reading the file. And the
  list stops where scores fall well below the best hit instead of always
  returning twenty; what was left out is counted on the last line, and an
  explicit `limit` returns everything.
- Word forms match ("parsing" finds `parseConfig`), filler words in a question
  are ignored, and keys of object literals written inline in a function no
  longer outrank the functions and types being looked for.
- `map symbol=…` says so when the name was ambiguous and names the other
  candidates, instead of silently answering for the top-ranked one. It also
  accepts the short form search results print (`Client#connect`).

### Fixed
- **The home directory could be taken for the project.** The machine-wide
  cache lives in `~/.cgraph`, the same name as a project's index directory,
  and project-root detection counted it as one. Once the cache existed — after
  the first grammar download or `cgraph trust` — any directory under the home
  directory that had not been initialised resolved to the home directory
  itself, so `cgraph index` in a fresh clone set about indexing all of it.
  The cache directory is no longer a project marker unless it actually holds
  an index. `cgraph init` was unaffected; it takes its root from where it is
  run.
- **A `.tsx` file could be indexed with no symbols.** `tsx` is served by the
  typescript pack, but lazy loading looked for a pack *named* `tsx`, found
  none, and marked the language unavailable for the rest of the run. In a
  repository not detected as TypeScript, whether its `.tsx` files got symbols
  depended on whether the walk reached a `.ts` file first.
- **Every index run looked like the packs had changed.** The pack fingerprint
  covered whichever packs were loaded at that moment, and builtins load lazily
  — so the fingerprint stored at the start of a run never matched the one
  computed at the start of the next. Each mismatch re-read every file skipped
  for lack of queries and re-resolved the whole graph: a second full pass
  after every real change in the MCP server, and again whenever the CLI and
  the server took turns. The fingerprint now covers what is on disk.
- **A pending full re-index could be lost.** A migration that needs one set a
  flag on the Store object of whichever process opened the database first —
  as often `cgraph find` or the MCP server as the indexer — and the flag died
  with that process. It is now stored in the database until a full index has
  actually run.
- Edges pointing *into* a re-indexed file were meant to be deleted explicitly
  but the statement ran after its own subquery had been emptied. (Foreign-key
  cascades removed them anyway; the statement now does what it says.)
- `_` and `%` in a search query or symbol name were treated as wildcards.
- The MCP server's freshness scan was throttled at a fixed three seconds. On a
  very large repository the scan itself takes longer than that, so every
  spaced-out query waited for one. Scans are now at least five scan-lengths
  apart.

### Performance
- **A first index is about six times faster.** Measured on llama.cpp (4,025
  files, 178 MB) on a 16-thread machine: 19.3s → 3.4s, producing an identical
  graph. Three separate causes:
  - Doc-comment lookup rescanned everything above each definition, once per
    definition — quadratic in file size, and 40% of total index time by
    itself. Hooks now read upwards only as far as the comment
    (`linesAbove` / `trimEndIndex`, exported from `cgraph/sdk` for pack
    authors whose `docComment` hook has the same shape).
  - Parsing ran on one thread, which is why CPU usage sat near 1/N on an
    N-core machine. A large index now parses on a pool of threads (cores − 1,
    up to 8; `--workers <n>` or `workers` in config to change it, `1` to turn
    it off). Rows are written in dispatch order, so the result is the same
    whatever the thread count. Incremental updates and the MCP freshness
    check stay single-threaded — they are too small for threads to pay off.
  - Files are read ahead asynchronously, unparsed files are written in
    batches instead of one transaction each, and each parsed file was being
    cleared twice before it was written.
- **Re-indexing files that are already indexed no longer scans whole tables.**
  Deleting a file's old rows searched `trigrams` and `refs` without an index,
  so updating one file cost more the larger the repository was, and
  `index --force` on an indexed repository took several times longer than
  indexing it from empty (4.5s → 0.7s on this repository). Schema v4 adds the
  two indexes; existing databases migrate on first open. An index opened by
  this version can no longer be opened by 0.7.0 or earlier.

### Changed
- `init` and `index` show what they are doing. Progress is reported in named
  phases — scanning, indexing, resolving, ranking — and the indexing phase
  draws a bar with a percentage, a rate and a time estimate, because the scan
  now runs first and supplies the total. Previously it was a bare counter
  followed by a silent pause while references were resolved, which on a large
  repository was indistinguishable from a hang. Runs over two seconds end with
  a line saying where the time went. Nothing is drawn when output is piped.

## [0.7.0] — 2026-11-10
### Security
- **Project packs and project embeddings settings now need `cgraph trust`.**
  A pack under `.cgraph/packs/` or `node_modules/cgraph-pack-*` is JavaScript
  that was imported — executed — on every index, including the automatic
  refresh the MCP server runs before each tool call. Opening a cloned
  repository with an agent was therefore enough to run whatever that
  repository committed. Likewise `.cgraph/config.json` could enable embeddings
  with a `baseUrl` and `apiKeyEnv` of the repository's choosing, sending any
  environment variable to any host as a bearer token. Neither is used until
  the project is trusted; what was held back is named on stderr. The decision
  is stored in `~/.cgraph/trusted.json`, outside the project, so a repository
  cannot grant it to itself. Builtin packs and `~/.cgraph/packs/` are
  unaffected. **Breaking** for existing project packs and embeddings: run
  `cgraph trust` once per project, or set `CGRAPH_TRUST=1` in CI.
- `init` no longer writes `enableAllProjectMcpServers: true` into the
  checked-in `.claude/settings.json`. That approved, for every clone and
  without a prompt, any server later added to `.mcp.json`. Only `cgraph` is
  approved now, by name. An existing `true` is left as it is — remove it by
  hand if you did not set it yourself.
- `init` pre-approves only the tools the server exposes (`map`, `find`), not
  the removed `status`, `read` and `graph`.
- The git hook single-quotes the project path. A directory name containing
  `$(...)` or a backtick was executed on every checkout, merge and rebase.
  Re-run `cgraph hooks uninstall && cgraph hooks install` to rewrite hooks
  installed by an earlier version.
- A file path read back from the index can no longer resolve outside the
  project root (`cgraph read` against a pre-built, committed index).
- Grammar downloads time out after 60 seconds instead of hanging the index.
- CI runs with a read-only token, and `prepare-release` passes its inputs to
  the shell as environment variables rather than interpolating them.

### Fixed
- **The registered MCP server failed to start unless `cgraph` was installed
  globally**, and always failed that way on Windows, where the global command
  is a `.cmd` shim that cannot be spawned without a shell. The only symptom
  was the agent reporting "connection closed". `init` now writes a bare
  `cgraph` only where it resolves (through `cmd /c` on Windows) and otherwise
  this Node binary plus the absolute path of the script. Re-running `init`
  repairs an entry an earlier version wrote; customised entries are untouched.

### Changed
- **Outlines hide object-literal fields that sit inside functions** — inline
  option objects and returned literals such as `{ recursive: true }`. They were
  a third to a half of a typical JavaScript outline and none of its structure.
  A footer counts what was hidden, and `kinds: ["field"]` lists them. Members
  of module-level objects and of classes are shown as before.
- MCP responses stop at 10,000 tokens when the caller passes no `budget`
  (`maxResponseTokens`; `0` disables). Ordinary answers are nowhere near it;
  it exists so that a huge outline is cut here, loudly and with a count,
  instead of by the client, which drops the result without saying what was
  lost. An explicit `budget` overrides it in either direction.
- The server sends short `instructions` at initialize, which clients that
  defer tool schemas keep in context to decide when to load the tools, and
  marks every tool `readOnlyHint` so calls can run in parallel and unprompted.
- The instruction block written into `CLAUDE.md` / `AGENTS.md` is about 40%
  smaller. It is loaded into every session, used or not.

## [0.6.0] — 2026-11-08

## [0.5.0] — 2026-08-01
### Changed
- **`map` and `graph` are merged into one MCP tool.** Pass `path` for a
  structural outline or `symbol` for relationships (callers, callees,
  importers, impact, path, explore) — never both. `read` and `status` are no
  longer separate MCP tools (an agent's own file reader and the automatic
  per-call refresh already cover them); both remain available from the shell
  as `cgraph read` and `cgraph stats`. MCP responses are no longer truncated
  to a default token budget — every tool still accepts an explicit `budget`
  to cap output on request.

### Removed
- **The `docs` tool and dependency-doc extraction (`src/deps/`).** Reading
  `node_modules`/`site-packages`/NuGet/Maven and fetching registry artifacts to
  build a usage-ranked API reference was a large, separately-maintained
  subsystem better served by a dedicated docs MCP server (e.g.
  [Context7](https://github.com/upstash/context7)). `cgraph docs`, the MCP
  `docs` tool, and `openProject(...).dependencies()` are gone; `map`/`graph`
  still show external call edges from the existing import graph.

### Added
- **Images are recognized by extension and never read.** `.png`, `.ico`,
  `.jpg`, and similar formats used to be read fully into memory and hashed
  before the binary sniff threw them away, which made `index`/`update` look
  stuck on large icon sets or design assets for no reason. They now take the
  same stat-only fast path as oversized files, tagged with a distinct
  `image` skip reason (visible in `update`'s "skipped by reason" and in
  `doctor`) instead of being folded into the generic `binary` count.
- **Unparsed files are findable again.** `find` only ever searched symbols,
  so a file with none — an image, a binary, anything skipped as too-large,
  minified, or generated — was invisible to it even though the index knew it
  existed; `map` already listed such files but didn't say why they weren't
  parsed. `find <name>` now also matches on the path of unparsed files, `map`
  annotates each with its skip reason (e.g. `(image)`, `(too-large)`) instead
  of a bare `(not parsed)`, and `graph` gives a specific error when a target
  is an indexed file with no symbols rather than reporting it as unknown.

## [0.4.0] — 2026-07-27
### Added
- **JSON, CSS, HTML, and Bash language packs.** JSON object keys and CSS
  rules/keyframes become nested symbols the same way code does; HTML surfaces
  landmark tags, `<script>`/`<style>` blocks, and any element with an `id`
  (narrow by design — every `<div>` as a symbol would be noise); Bash extracts
  function definitions and resolves calls between them. A YAML pack ships
  alongside these but is not yet registered: the bundled tree-sitter grammar
  fails to parse under the pinned `web-tree-sitter` version, so YAML files
  still fall back to being indexed as unparsed stubs until that combination is
  fixed upstream.
- **`packs.strict` config option.** Off by default. A project can turn off the
  "load an unpredicted language on first sight" fallback, so only packs for
  languages its own manifests actually named are ever used — a vendored
  script in an unexpected language becomes a stub instead of silently pulling
  in a grammar+pack for it.
- **`cgraph init` pre-approves its own MCP tools for Claude Code.** Previously
  `init` registered the MCP server and wrote the tool-usage instructions, but
  the tools still sat behind a permission prompt in the checked-in project
  config — fine for an interactive session where a human clears it once, but
  a subagent spawned non-interactively has nobody to click "allow", so a
  denied call looked exactly like a missing tool and the model fell back to
  grep. `init` now also writes the approval into `.claude/settings.json`
  (shared, not the gitignored `settings.local.json`), additively and without
  touching anything a user already set there.

## [0.3.0] — 2026-07-27
### Added
- **Sub-project detection.** A root that bundles several independently-cloned
  repos — a frontend/backend/desktop fleet of microservices, each its own git
  checkout, opened as one workspace — now has every file labeled with which
  nested repo it belongs to. `cgraph init` and `cgraph map` report each
  detected sub-project alongside its own stack and frameworks, so an agent
  working across the fleet can tell an Angular file from an ASP.NET file at a
  glance instead of treating the whole tree as one undifferentiated project.
  A nested repo's own local `.git/info/exclude` is now honored too, the same
  way `.gitignore` and `.cgraphignore` already were. Off switch:
  `detectSubprojects: false`.

## [0.2.5] — 2026-07-26
## [0.2.4] — 2026-07-26
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

[Unreleased]: https://github.com/Ramachandrajoshi/Code-Graph/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.7.0
[0.6.0]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.6.0
[0.5.0]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.5.0
[0.4.0]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.4.0
[0.3.0]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.3.0
[0.2.5]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.2.5
[0.2.4]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.2.4
[0.2.3]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.2.3
[0.2.2]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.2.2
[0.2.0]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.2.0
[0.1.1]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.1.1
[0.1.0]: https://github.com/Ramachandrajoshi/Code-Graph/releases/tag/v0.1.0
