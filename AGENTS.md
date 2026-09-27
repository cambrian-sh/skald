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
engine and the Skald filesystem helper automatically. `bun run check`,
`bun run dev`, and `bun run build` compile the helper with `cc`. Never add
generated engine or addon binaries: ignore rules prevent new files from being
tracked but cannot untrack a blob already committed. Review
[RELEASING.md](RELEASING.md) before pushing or publishing.

Do not modify the existing Cambrian or `codebase-memory-mcp` repositories from
this repository's implementation. Cambrian integration belongs behind a
profile boundary.
