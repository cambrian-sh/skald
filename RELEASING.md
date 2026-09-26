# Releasing Skald

Skald releases are cut from a versioned commit on the repository's default
branch. A release publishes one universal `@cambrian/skald` package, four
OS/CPU-constrained Afşin engine companions, and four self-contained executable
downloads.

Before the first push, ensure the history being published contains no large
generated engine binaries; `.gitignore` prevents new binaries from being staged
but cannot remove a blob already committed. Check the repository's ship audit
for the current first-release status.

Before enabling releases, protect the default branch with the repository's
required review/CI checks and add a tag ruleset restricting `v*` creation to
maintainers. The workflow also rejects a version tag that does not point to a
commit on the default branch.

## Consumer installation

With Bun 1.3 or newer:

```sh
bunx @cambrian/skald setup
```

The npm package installs only the native engine companion for the current OS
and CPU. The standalone GitHub Release executables embed both Skald and Afşin
and need no Bun or second download. The first release supports Linux
amd64/arm64 and macOS arm64/amd64. Windows and BSD are not currently supported
release targets.

## Cut a release

1. Update `version` in `package.json` in a reviewed commit on the default
   branch. The release workflow requires the tag to match that exact version.
2. After the commit is merged, create and push its annotated tag:

   ```sh
   git tag -a vX.Y.Z -m "Skald vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. The `Release assets` workflow builds the pinned Afşin commit on all four
   native runners, verifies each binary and standalone executable, combines the
   engine manifests, and refuses to package the universal CLI unless all four
   target assets are present and consistent.
4. The workflow publishes companions first and the CLI package last using npm
   trusted publishing (OIDC), installs the published package on every native
   target, runs setup, checks Afşin's full MCP contract, and retrieves context
   before creating or updating the GitHub Release. Release assets include both
   licenses, checksums, and GitHub artifact attestations. Re-running a release
   is safe: an already-published version is skipped only when its registry
   integrity exactly matches the release archive.

The source-tree `prepublishOnly` guard is intentional. Do not publish
`package.json` directly: it does not contain the complete release manifest or
the platform companion archives.

## One-time npm bootstrap

npm requires a package to exist before a trusted publisher can be configured.
The five release names did not resolve publicly during this audit, so treat the
first release as a deliberate package bootstrap; later versions do not need an
npm write token. If any name is already owned or private when you prepare the
release, resolve its ownership/access before publishing.

1. Push the first version tag. The workflow builds and attaches a 30-day Actions
   artifact named `skald-release-vX.Y.Z` before attempting npm publication. The
   publish job will fail until the five packages exist and trust is configured.
2. Download and unpack that Actions artifact. With an npm account authorized to
   publish the `@cambrian` scope and 2FA enabled, publish the four engine
   companions first, then the CLI archive. Do not put an npm token in the
   repository or workflow:

   ```sh
   npm publish cambrian-skald-engine-linux-amd64-X.Y.Z.tgz --access public
   npm publish cambrian-skald-engine-linux-arm64-X.Y.Z.tgz --access public
   npm publish cambrian-skald-engine-darwin-arm64-X.Y.Z.tgz --access public
   npm publish cambrian-skald-engine-darwin-amd64-X.Y.Z.tgz --access public
   npm publish cambrian-skald-X.Y.Z.tgz --access public
   ```

3. Using npm CLI 11.15.0 or newer, configure the publisher on each package. The
   commands require package write access and account-level 2FA:

   ```sh
   npm trust github @cambrian/skald --repo cambrian-sh/skald --file release-assets.yml --allow-publish
   npm trust github @cambrian/skald-engine-linux-amd64 --repo cambrian-sh/skald --file release-assets.yml --allow-publish
   npm trust github @cambrian/skald-engine-linux-arm64 --repo cambrian-sh/skald --file release-assets.yml --allow-publish
   npm trust github @cambrian/skald-engine-darwin-arm64 --repo cambrian-sh/skald --file release-assets.yml --allow-publish
   npm trust github @cambrian/skald-engine-darwin-amd64 --repo cambrian-sh/skald --file release-assets.yml --allow-publish
   ```

4. In Actions, choose **Re-run failed jobs**, not **Re-run all jobs**. GitHub
   reuses the successful assembly artifact and reruns the publish job plus its
   downstream consumer and GitHub Release jobs. The publisher verifies each
   seeded package's registry integrity against that exact archive and skips
   exact matches. Remove or revoke any temporary bootstrap credential
   afterward. Consider disallowing token publishing once OIDC is confirmed.

GitHub retains this workflow's assembled release artifact for 30 days; perform
the seed and rerun within that window. See [GitHub's rerun behavior](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

The first manually seeded npm versions do not receive npm's OIDC-generated
provenance. Their matching archives still have GitHub artifact attestations;
subsequent OIDC-published versions receive npm provenance automatically when
the repository and packages are public.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[npm `trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/) for current
requirements.
