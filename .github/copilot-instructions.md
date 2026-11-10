# Working on cgraph

Repository conventions and architecture live in [AGENTS.md](../AGENTS.md).
VS Code reads that file too; this one repeats the tool guidance so it applies
even when only Copilot instructions are loaded.

<!-- cgraph:start -->
## Code navigation: use cgraph, not grep

This repo has a cgraph index. Unless you already know the exact lines you need:

- `find <name>` instead of grep for a symbol: ranked definitions with exact
  locations. Matches camelCase parts ("login" finds "handleLogin").
- `map <path>` instead of ls/glob or opening a file: a symbol outline with
  line numbers, a fraction of the file's size. Then read only those lines.
- `map <symbol>` for callers, callees and call paths. Use `direction=impact`
  before changing anything shared.

`map` takes a `path` or a `symbol`, never both. Edges marked `!` are
**inferred** from a name match, not proven — verify them. Only definitions and
call/import edges are indexed: use grep for plain text and your own reader for
file contents. The index refreshes itself; `cgraph update` forces it. Without
the MCP tools, the shell has the same data: `cgraph map|find|graph|read`.
<!-- cgraph:end -->
