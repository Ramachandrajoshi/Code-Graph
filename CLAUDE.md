# Working on cgraph

Repository conventions, architecture, and the traps that have cost real time
live in **[AGENTS.md](AGENTS.md)** — read that first when contributing.

The section below is the tool guidance, repeated here because Claude Code reads
this file directly.

<!-- cgraph:start -->
## Code navigation: use cgraph, not grep

This repository has a cgraph index. Prefer these tools over shell search: they
return the specific thing asked for rather than whole files, so answers are much
smaller and carry exact locations.

| Instead of | Use | Returns |
|---|---|---|
| `ls`, `glob`, opening a file to see what's in it | `map` | symbol outline with line numbers |
| `grep` for a symbol | `find` | ranked definitions; matches camelCase parts, so "login" finds "handleLogin" |
| reading a whole file | `read` | one symbol, or an exact line range |
| — no shell equivalent — | `graph` | callers, callees, transitive impact, call paths |
| reading node_modules or searching the web for an API | `docs` | the dependency API *this* repo actually calls |

Working rules:

- Start with `map` before exploring: an outline of a file is a small fraction
  of the file itself, and tells you which one symbol is worth reading in full.
- Before changing anything shared, run `graph` with `direction=impact` to see
  what depends on it.
- Edges marked `!` are **inferred** from a name match, not proven through an
  import. Verify before relying on them.
- If results look stale, call `status` — it re-indexes changed files.
- `read` accepts `Class#method` and `path/to/file.ts:20-40`.

The same data is available from the shell if MCP is unavailable:
`cgraph map|find|read|graph|docs`.
<!-- cgraph:end -->
