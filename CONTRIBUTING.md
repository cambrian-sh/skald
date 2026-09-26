# Contributing to Skald

Skald is a TypeScript + Bun CLI. The normal development check is `bun run
check`; a standalone build additionally needs the pinned Afşin engine for the
host platform.

## Prerequisites

- Bun 1.3 or newer; use 1.3.14 to match CI.
- Git.
- A C build toolchain and the dependencies required by Afşin's pinned
  [`codebase-memory-mcp`](https://github.com/afsin-asf/codebase-memory-mcp)
  build script when producing a standalone executable locally.

## Checks

```sh
bun install --frozen-lockfile
bun run check
```

`bun run check` runs TypeScript checking, Biome, and the isolated test suite.
CI runs it on Linux and macOS. The Linux CI job also builds the pinned Afşin
engine, stages it, and verifies the standalone Skald build.

## Local standalone build

Release CI builds Afşin from commit
`cf1d310a72320ec55e7b86a091561162567e55d2`; it does not download a checked-in
binary. For a local build on Linux or macOS, build that commit and stage the
native output for your current platform:

```sh
mkdir -p .release
git clone https://github.com/afsin-asf/codebase-memory-mcp.git .release/afsin-engine
git -C .release/afsin-engine checkout cf1d310a72320ec55e7b86a091561162567e55d2
(cd .release/afsin-engine && scripts/build.sh)
bun run stage:engine -- \
  --binary .release/afsin-engine/build/c/codebase-memory-mcp \
  --platform linux \
  --arch amd64
bun run build
```

For macOS, build with `scripts/build.sh --arch arm64` on Apple Silicon or
`scripts/build.sh --arch x86_64` on Intel, then stage with `--platform darwin`
and Skald's `--arch arm64` or `amd64`, respectively. The release workflow is
authoritative for all four targets. Staging updates
`vendor/engine/manifest.json`; inspect that change. The root ignore rule keeps
newly staged native executables out of Git; it cannot untrack a binary already
committed. Review [RELEASING.md](RELEASING.md) before pushing or publishing. The
source tree's `bun run build` produces a host-specific standalone executable,
not a cross-compiled release.

## Product integration tests

Use disposable Git repositories under the system temporary directory. The
tests exercise real file publication, Git ignore behavior, MCP stdio, process
cleanup, and a packed-package consumer; avoid using a working Cambrian project
as a fixture. `bun run check` is the acceptance command before changing docs,
configuration adapters, project storage, or MCP lifecycle behavior.

## Release process

Only the tag-triggered workflow builds and assembles the four native engine
companions and one universal CLI package. Follow [RELEASING.md](RELEASING.md);
do not publish the source-tree `package.json` directly.
