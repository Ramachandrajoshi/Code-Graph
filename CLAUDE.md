# Working on cgraph

Repository conventions, architecture, and the traps that have cost real time
live in **[AGENTS.md](AGENTS.md)** — read that first when contributing.

The section below is the tool guidance, repeated here because Claude Code reads
this file directly.

<!-- cgraph:start -->
## Code navigation: use cgraph, not grep

This repository has a cgraph index. Use it — not just shell search — whenever
you haven't already pinpointed the lines you need; it returns exact locations
instead of whole files. `map` takes either a `path` (outline) or a `symbol`
(relationships), never both.

| Instead of | Use | Returns |
|---|---|---|
| `ls`, `glob`, opening a file to see what's in it | `map` (path) | symbol outline with line numbers |
| grepping/searching for a symbol | `find` | ranked definitions; matches camelCase parts, so "login" finds "handleLogin" |
| — no shell equivalent — | `map` (symbol) | callers, callees, transitive impact, call paths |

Working rules:

- Call `map` on a file before opening it: an outline is a fraction of the
  file's size and tells you which symbol is worth reading in full.
- Before changing anything shared, call `map` on the symbol with
  `direction=impact` to see what depends on it.
- Edges marked `!` are **inferred** from a name match, not proven through an
  import. Verify before relying on them.
- The index refreshes itself before every call; if it still looks stale, run
  `cgraph update`.
- Use your own reader for whole-file or line-range reads; `find`/`map` only
  index definitions and call/import edges, not plain text — fall back to grep
  for that.

The same data is available from the shell, which also keeps `read` and
`graph` as separate commands: `cgraph map|find|graph|read`.
<!-- cgraph:end -->
