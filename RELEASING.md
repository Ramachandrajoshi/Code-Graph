# Releasing

Releases are cut from `main`, tagged, and published to npm automatically by
GitHub Actions. The **tag is the trigger** — nothing reaches the registry
without one, and nothing is tagged that disagrees with `package.json`.

## The normal path

```bash
npm run release -- patch      # or minor, major, or an exact version
```

That script does the whole thing, and refuses early if anything is wrong:

1. **Preflight** — on `main`, clean tree, in sync with `origin/main`, target
   version not already tagged or published.
2. **Verify** — full test suite.
3. **Confirm** — prints exactly what will happen and waits for `y`.
4. **Apply** — bumps `package.json`, promotes the `Unreleased` CHANGELOG section,
   commits, tags, pushes.

Use `--dry-run` to see the plan without touching anything.

Pushing the tag starts [`release.yml`](.github/workflows/release.yml), which:

1. re-checks that the tag matches `package.json` and the version is unpublished
2. runs tests **and** the benchmark — a release that regressed the token-savings
   claim should not ship quietly
3. verifies the tarball contains the query files and grammar manifest, and
   leaks no tests
4. **installs the packed tarball into a scratch project and runs it**, catching
   the class of bug where the repo works but the published package does not
5. publishes to npm with provenance
6. creates the GitHub Release from the CHANGELOG section

## The review path

When a release deserves review before it happens, use the
**Prepare release** workflow from the Actions tab. It opens a PR from a
`release/vX.Y.Z` branch containing only the version bump and changelog move.
Merge it, then tag:

```bash
git checkout main && git pull
git tag v0.2.0 && git push origin v0.2.0
```

Nothing publishes until that tag exists, so an unwanted release is a closed PR
rather than an immutable bad version.

## Prereleases

```bash
npm run release -- prerelease --preid beta      # 0.2.0-beta.0
```

Prereleases publish under the `beta` dist-tag and are marked as prereleases on
GitHub, so `npm install code-graph` continues to give people the stable version.
Install one explicitly with `npm install code-graph@beta`.

## Versioning

[Semantic Versioning](https://semver.org). While `0.x`, the public surface is
still settling; from `1.0.0` these are the compatibility boundaries:

| Surface | Breaking change means |
|---|---|
| CLI commands, flags, output shape | removing or renaming either |
| MCP tool names and input schemas | removing a tool or a parameter |
| `code-graph` and `code-graph/sdk` exports | removing or changing a signature |
| Language pack contract | removing a hook or changing what it receives |
| Index schema | requiring a rebuild rather than migrating |

Adding a language pack, a hook, or an optional parameter is a **minor**.
Extraction-quality improvements are **patch**, even though they change output.

---

## One-time setup

### 1. First publish (manual — required)

npm's trusted publishing is configured **in a package's settings**, so the
package has to exist before it can be configured. The very first release is
therefore published by hand:

```bash
npm login
npm publish
```

Every release after this one goes through CI.

### 2. Configure trusted publishing

At <https://www.npmjs.com/package/code-graph/access>, under **Trusted Publisher**,
choose GitHub Actions and enter:

| Field | Value |
|---|---|
| Organization or user | `Ramachandrajoshi` |
| Repository | `Code-Graph` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |
| Allowed actions | `npm publish` |

This binds publishing rights to that one workflow file in that one repository.
A workflow added by an attacker — or a leaked token, since there is no longer a
token — cannot publish.

> npm does not validate this configuration when you save it. The first automated
> release is the real test; if it fails on auth, check these fields character by
> character.

### 3. Create the `npm` environment

In GitHub → Settings → Environments, create an environment named `npm`.

Optional but worth it: add yourself as a **required reviewer**. Publishing then
pauses for an explicit approval click, which is a cheap last line of defence
against a tag pushed by mistake.

### 4. Requirements

- npm CLI **>= 11.5.1** and Node **>= 22.14** on the runner (the workflow
  installs `npm@latest` so a future runner image cannot silently downgrade this
  into token-based auth)
- `id-token: write` permission on the publish job — without it npm falls back to
  token auth and fails
- `repository` populated in `package.json`, which provenance requires

## No tokens

There is deliberately no `NPM_TOKEN` secret. Authentication is OIDC: GitHub
mints a short-lived token for that specific workflow run, npm verifies it against
the configured trust relationship, and it expires immediately. Nothing long-lived
exists to leak, rotate, or accidentally print into a log.

Every published version also carries a signed provenance attestation linking it
to the exact commit and workflow run that built it, visible on the npm package
page.

## If a release goes wrong

**Failed before publishing** — fix the problem, delete the tag, run again:

```bash
git tag -d v0.2.0 && git push --delete origin v0.2.0
```

**Failed after publishing** — the version is on npm and npm versions are
immutable. Do not attempt to unpublish (it is restricted, disruptive, and
breaks anyone who already installed). Ship a patch instead.

For something genuinely dangerous, deprecate the bad version so installers see a
warning, then release the fix:

```bash
npm deprecate code-graph@0.2.0 "Broken release; use 0.2.1 or later."
```
