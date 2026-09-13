# Skald engine assets

This directory is the release-time home for the pinned Afşin
`codebase-memory-mcp` native engine. The source repository and commit are
recorded in `manifest.json`. The redistributed engine is covered by
`AFSIN-LICENSE`.

Platform assets are staged with:

```sh
bun run stage:engine -- \
  --binary /path/to/codebase-memory-mcp \
  --platform linux \
  --arch amd64
```

The staging command rejects symlinks and oversized inputs, copies atomically,
applies executable mode to the published asset, computes SHA-256, and records
the asset in the manifest. A publishable package must contain an asset for every
target it advertises. Skald has no generic-engine fallback when the official
asset is missing.
