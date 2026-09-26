# Skald Repository Guide

Skald is a TypeScript + Bun CLI for project context and memory. Keep the
first-party CLI dependency-light and preserve the non-mutating behavior of
`init --dry-run`.

## Verification

```sh
bun run check
bun run build
```

Before building from a clean checkout, stage the host-specific Afşin engine as
described in [CONTRIBUTING.md](CONTRIBUTING.md). Release CI builds the pinned
engine and stages it automatically. Never add engine binaries: the root ignore
rule prevents future untracked additions, but a legacy Linux binary remains in
the unpublished Git history. See [RELEASING.md](RELEASING.md) before the first
push.

Do not modify the existing Cambrian or `codebase-memory-mcp` repositories from
this repository's implementation. Cambrian integration belongs behind a
profile boundary.
