# Skald engine assets

This directory contains Skald's pinned, source-only Afşin
`codebase-memory-mcp` snapshot and the release-time home for its native engine.
The source repository, commit, Git tree, exact archive digest, byte count, and
excluded generated artifacts are recorded in `source/manifest.json`. The
runtime engine identity is recorded in `manifest.json`. The redistributed
engine and source are covered by the upstream licenses, including
`AFSIN-LICENSE`.

Native executables are build artifacts, not repository files. Release CI
verifies and extracts the co-located source snapshot, builds the runner's
native target, and stages the binary here. Skald also builds its first-party
`skald-safe-fs.node` Node-API helper for the same target. It is packaged beside
the engine in that target's companion and embedded in standalone executables;
it is not an Afşin engine asset and is not listed in the engine manifest.
`.gitignore` excludes generated native files so local builds cannot add large
or host-specific artifacts to a commit. A fresh source checkout must stage its
host engine asset before `bun run build`; that command builds the helper
automatically. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

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
