# Skald Repository Guide

Skald is a TypeScript + Bun CLI for project context and memory. Keep the
first-party CLI dependency-light and preserve the non-mutating behavior of
`init --dry-run`.

## Verification

```sh
bun run check
bun run build
```

Do not modify the existing Cambrian or `codebase-memory-mcp` repositories from
this repository's implementation. Cambrian integration belongs behind a
profile boundary.
