# Skald engine assets

This directory is the release-time home for the pinned Afşin
`codebase-memory-mcp` native engine. The source repository and commit are
recorded in `manifest.json`. The redistributed engine is covered by
`AFSIN-LICENSE`.

Native executables are build artifacts, not repository files. Release CI checks
out the pinned source, builds the runner's native target, and stages the binary
here. `.gitignore` excludes staged executables so a local build cannot add a
large engine blob to a commit. A fresh source checkout must stage its host
asset before `bun run build`; see [CONTRIBUTING.md](../../CONTRIBUTING.md).

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
