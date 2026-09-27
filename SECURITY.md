# Security policy

Skald runs locally and connects coding agents to project context through MCP.
It does not require a hosted Skald service or call a hosted language model.
The configured coding agent may send context to its own provider under that
agent's settings and policies.

## Reporting a vulnerability

Please do not publish exploitable details in a public issue. If private
vulnerability reporting is enabled, use **Report a vulnerability** on the
repository's GitHub Security page. Otherwise contact the Cambrian maintainers
through a private channel listed by the
[Cambrian GitHub organization](https://github.com/cambrian-sh). Include the
affected version/commit, platform, impact, and a minimal reproduction. Do not
include real credentials or private project data.

There is no published response-time commitment yet. Maintainers should
coordinate disclosure and a fix before publishing exploit details.

## Trust boundaries

- Project files, MCP configuration, engine metadata, and declared knowledge
  paths are input, not permission. Repository configuration cannot authorize
  execution of a custom backend or reading an external knowledge directory.
- The default `setup` path provisions the Afşin engine pinned in the release
  manifest. A custom `--mcp-command` is an explicit request to attest and trust
  that executable for the current user.
- Backend execution is bounded and supervised. Generated agent configuration
  routes an attested backend through Skald's verified runtime; secret-looking
  environment variables are not persisted into project configuration.
- Managed project files are opened and changed relative to held directory
  descriptors with no-follow OS operations on the supported Linux/macOS targets.
  A small Skald-owned Node-API helper supplies those syscalls; bounded file
  handling and publication policy stay in TypeScript. If the matching helper
  is missing or invalid, managed operations fail closed.
- Canonical knowledge outside the project requires explicit user approval.
  Session records are kept separate from promoted canonical records.

## Local data and Git

Engine executables, graph/cache state, daemon rendezvous files, freshness state,
generated context launchers, and unreviewed session memory live under
`.skald/`. Skald creates a managed block in `.skald/.gitignore` to keep those
machine-local artifacts out of ordinary Git status while leaving promoted
`.skald/knowledge-canonical/` records shareable.

`.gitignore` is not an access-control boundary and cannot untrack files already
committed or staged. Do not store credentials in project knowledge. Review
promoted records before committing them; agents with project access can read
the context made available to them.

## Release integrity

Release assets include SHA-256 checksums and GitHub artifact attestations.
Automated npm publication uses trusted publishing when configured; the initial
manually bootstrapped package versions do not carry npm-generated OIDC
provenance. These controls are not a publisher signature or macOS notarization.
See [RELEASING.md](RELEASING.md) for the actual bootstrap and verification
limits.
