# Skald

The npm package is published as `@cambrian/skald` because the unscoped `skald`
name is already occupied; its installed executable remains `skald`.

Skald is a Bun-powered modular monolith for project context and memory for
Claude Code, Codex, and OpenCode. It discovers project guidance, owns the
context and session-memory surface, supervises structural retrieval, and writes
safe, client-specific configuration without touching global settings during
normal initialization.

Skald ships Afşin's native `codebase-memory-mcp` as its official structural
engine. It is an internal subprocess boundary for isolation and lifecycle
control, not a second product or a dependency that developers assemble. Skald
owns setup, project-local storage, context retrieval, knowledge, agent
adapters, trust, and automation. A custom MCP engine remains an explicit
advanced extension; discovery never grants it execution authority.

## Requirements

- Bun 1.3 or newer
- The checked-in development asset is Linux amd64; release builds stage a
  matching pinned Afşin asset for each supported target before publication
- The fully managed filesystem path is currently supported on Linux, macOS, and
  BSD; Windows fails closed for managed project writes until descriptor-safe
  support exists
- `skald setup` installs the pinned Afşin engine shipped for the current target;
  `skald init` remains available as an offline configuration path

Managed project files currently require Linux, macOS, or a BSD with
descriptor-safe directory operations. On other platforms Skald fails closed
before writing; it does not silently downgrade the filesystem safety guarantee.

## Install and use

Once published, install and set up a project with:

```sh
bunx @cambrian/skald setup
```

From this repository:

```sh
bun install
bun run src/cli.ts setup
```

Skald will:

1. Find the enclosing Git project.
2. Inventory `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Copilot instructions,
   Cursor rules, and skills in the common `.agents`, `.claude`, `.opencode`,
   and `.github` roots.
3. Plan the versioned `.skald/config.json`, bootstrap, and client integrations.
4. Install the bundled, pinned Afşin engine into `.skald/engine/`, verify its
   full MCP contract, and record its digest and provenance.
5. Preflight and index the project in `fast` mode, recording the engine digest,
   Git revision, coverage status, and bounded run history; a failed initial
   index publishes no project integration.
6. Publish the manifest, bootstrap, runtime, and selected Claude/OpenCode
   configuration, and report that Codex requires explicit global installation.

The initializer compiles a project-local context runtime at
`.skald/context-runtime.mjs` and configures Claude Code and OpenCode with an
absolute Bun executable and absolute project-local runtime path. This makes the
generated project configuration independent of the package manager cache and
`PATH`. When running as a compiled standalone binary, Skald copies that binary
to `.skald/context-runtime` and configures the clients to launch the project-local
copy, so the original launcher can be moved or removed after setup.

Existing files are parsed before writes, comments are preserved for JSONC, and
managed paths reject symlinks and publish atomically on Linux, macOS, and BSD.
Skald fails closed before managed reads or writes on platforms without the
descriptor-safe filesystem primitives required for that guarantee. Use
`--dry-run` to inspect the complete plan without changing files:

```sh
skald init --dry-run --json
```

## Engine lifecycle

```sh
skald setup
skald engine install
skald engine locate
skald engine index --mode fast
skald engine conformance
skald engine conformance --smoke
skald engine serve
```

`setup` is the one-command path. The published Skald package installs its
matching platform companion containing Afşin's asset, pinned to commit
`cf1d310a72320ec55e7b86a091561162567e55d2`; setup copies it into the project
boundary, verifies all 16 tools and required input schemas, records its
SHA-256, and runs the initial index. No MCP path or `CBM_KNOWLEDGE_DIR` is
required for the default path. Standalone releases embed the same asset.
`init` is the offline configuration lifecycle
when the official asset is already present or a custom engine is intentionally
supplied. Use `--no-index` for configuration-only preparation. A project-local
binary found under `build/` is not executed unless explicitly adopted:

```sh
skald init --mcp-command /absolute/path/to/codebase-memory-mcp
```

An explicit command is attested, recorded in the user-scoped Skald trust
registry, and pinned in `.skald/config.json`, so the Skald context server can
reuse that decision on later requests. Repository-controlled `trust` fields
are informational and never grant execution permission by themselves.
`engine index` updates the external memory engine's project graph; `engine serve`
runs its MCP stdio process for clients that need a direct launcher. Use
`--no-index` when preparing a project before installing the backend:

```sh
skald init --no-index
```

The official asset and every generated engine directory live under `.skald/`:

```text
.skald/
├── engine/codebase-memory-mcp
├── engine/cache/
├── engine/config/
├── r/                         # default rendezvous; deep roots use an ephemeral short path
├── knowledge/
├── config.json
├── context.md
└── state.json
```

`engine install --package <exact-spec>` remains a legacy compatibility channel
for existing installations. It is never selected by `setup` and is not the
official Afşin engine.

The index state is kept in `.skald/state.json`. `skald context` and
`skald doctor` compare the recorded revision and engine digest with the current
project, and report `fresh`, `stale`, `degraded`, or `unknown` instead of hiding
stale structural results. Agents can request the same operation through the
`project_refresh` context tool.

New manifests use `onQuery: refresh`: when a trusted index is stale and the
working tree is clean, the first context request performs a bounded `fast`
refresh before asking the backend for results. Dirty worktrees are reported as
stale and require an explicit `project_refresh`, avoiding repeated expensive
re-indexing while files are being edited. Every successful index is recorded in
a bounded `.skald/state.json` run history with its trigger (`setup`, `manual`, or
`automatic`). Set
`freshness.onQuery` to `warn` when an environment needs fully manual refreshes,
or set `freshness.beforeWrite` to `warn` when it deliberately permits session
records before a verified index exists.

For Afşin's `codebase-memory-mcp`, Skald supplies a private project-local
`CBM_RUNTIME_DIR` at `.skald/r` whenever the absolute path fits the operating
system's Unix-socket limit. If a project is nested under a long path, Skald uses a
deterministic private directory under the OS runtime area for the ephemeral daemon
rendezvous; cache, configuration, knowledge, and graph state remain under `.skald/`.
An explicit runtime directory is supported when a deployment needs one.

Trusted project backend entries route through the generated runtime's `backend`
command. The runtime re-attests the configured backend and executes a verified
snapshot, so replacing the backend file after setup cannot silently change what a
client launches. Existing legacy backend entries remain untouched for compatibility.

For a custom or locally built engine, explicitly adopt its executable:

```sh
skald init --mcp-command /absolute/path/to/codebase-memory-mcp
```

Backend handshakes and tool calls have a finite 15-second deadline by default.
Set `SKALD_MCP_TIMEOUT_MS` to tune it between 100 ms and 10 minutes when a
larger project needs more time.

Skald passes a small safe environment allowlist to backend processes. Explicit
backend variables work for the invocation that approved them, but secret-looking
variables such as API tokens are never copied into generated project or agent
configuration. Configure those in the agent's environment. External
`CBM_KNOWLEDGE_DIR` roots also require explicit approval; roots inside the
project are trusted automatically.

## Agent configuration

Normal `init` never writes global configuration. Claude Code and OpenCode receive
project-local configuration. The installed Codex CLI currently requires an
explicit global opt-in:

```sh
skald agents install codex --global
```

The installer honors `CODEX_HOME`, preserves valid existing TOML and legacy
`codebase-memory-mcp` entries, adds the Skald context server, and adds the
backend only when it has been explicitly trusted. It refuses malformed or
symlinked files.

Select only the clients you use and pass environment variables to the engine:

```sh
skald init --agents claude,opencode \
  --mcp-command /absolute/path/to/codebase-memory-mcp \
  --mcp-arg serve --mcp-arg --stdio \
  --mcp-env CBM_KNOWLEDGE_DIR=/absolute/path/to/knowledge

# Optional: inject the current project context when a Claude session starts.
skald init --agents claude --hooks
```

When Skald finds an existing Cambrian-style `.claude/.mcp.json`, it preserves
the existing backend entry and reuses its supported command and environment for
discovery. This keeps the existing Afşin fork and `CBM_KNOWLEDGE_DIR` available
without allowing repository configuration to authorize Skald execution; pass
`--mcp-command` once when Skald should adopt that backend.
OpenCode project configuration is emitted in its v2 `mcp.servers` shape for
new files, while existing legacy layouts are preserved.

Skald owns the portable Cambrian-compatible knowledge lifecycle. It reads
canonical roots including `CBM_KNOWLEDGE_DIR`, and provides equivalent
reconciliation and synchronization commands:

```sh
skald knowledge reconcile --root /path/to/workspace \
  --knowledge-dir /path/to/cambrian-knowledge \
  --repo cambrian-core=/path/to/workspace/core
skald knowledge sync --write --root /path/to/workspace \
  --knowledge-dir /path/to/cambrian-knowledge \
  --repo cambrian-core=/path/to/workspace/core
skald knowledge index --write --mode fast --root /path/to/workspace \
  --knowledge-dir /path/to/cambrian-knowledge \
  --repo cambrian-core=/path/to/workspace/core
```

`reconcile` is read-only. `sync --write` updates only verification metadata
and Cambrian-style evidence status fields in the explicitly selected knowledge
root. `index` runs that sync lane and then indexes the configured structural
backend. `skald init --hooks` installs source-repository post-commit sync hooks
and a knowledge-repository post-commit index hook when those repositories are
discoverable. Skald does not require the native Afşin fork to expose a private
`index_knowledge` MCP tool: the portable orchestration lane preserves the same
observable lifecycle while using the public `index_repository` contract.

## Context and memory

The generated `skald-context` server gives agents a small, source-attributed
context surface before they edit:

```sh
skald context --json
skald context --path src/context --max-chars 24000 --json
skald doctor
skald memory record decision --title "Use MCP" \
  --summary "Keep the backend replaceable" --source README.md
```

`skald context` includes the contents of discovered instructions and skills,
relevant structural results from the indexed backend graph, plus records from
the configured `CBM_KNOWLEDGE_DIR` such as Cambrian ADRs, together with local
session records. Superseded and retired canonical records are excluded from
usable context. Skald negotiates the backend's advertised MCP tools, including
their input schemas, using Afşin's graph and code search together when
available and a compatible subset otherwise. It checks backend index coverage,
ranks sources
deterministically and enforces a bounded context budget; the response reports
when sources were omitted. `--path` scopes repository guidance and supported
backend searches. Set `SKALD_CONTEXT_MAX_CHARS` to tune the budget between
4,000 and 1,000,000 characters. If the backend is unavailable or the project
has not been indexed, the response keeps local context and reports an explicit
warning.

Records created by Skald are kept in `.skald/knowledge` with session authority,
deduplicated by content fingerprint, and can use the Cambrian kinds `adr`,
`decision`, `observation`, `measurement`, `component`, `contract`,
`investigation`, and `research`. Canonical knowledge directories remain
read-only and require maintainer review. Review and govern session records
explicitly:

```sh
skald memory review
skald memory promote <path-printed-by-memory-record>
skald memory reject <path-printed-by-memory-record>
```

Promotion writes a canonical, revision-anchored copy under
`.skald/knowledge-canonical` and stops on a conflicting title/kind record.
Rejection keeps the session record auditable while removing it from usable
context.

The default manifest policy is `beforeWrite: require-verify`: a new record is
accepted only when the project has a trusted, current, non-degraded structural
index. If the project is mid-edit or the backend cannot be verified, Skald
returns the reason and asks for an explicit refresh before recording memory.
`beforeWrite: warn` is an explicit opt-out from that gate and should be used
only when the project accepts unverified session discoveries.

## Development

```sh
bun install
bun run check
bun run build
```

`bun run build` creates a standalone Bun executable at `dist/skald`. Its
compiled setup path creates a project-local executable runtime when source
bundling is unavailable; the generated agent configuration contains that
project-local absolute path.

This is a technically verified local-first release candidate pending a committed
and tagged release baseline: `skald setup` installs the bundled or platform-companion Afşin engine,
configures the selected clients, indexes the project, refreshes stale trusted
indexes on demand, and exposes governed project memory. `engine conformance`
verifies all 16 Afşin registry tools and required input fields; `--smoke`
additionally exercises safe read-only graph operations against an indexed
project. Release builds stage one native asset per supported platform with
`bun run stage:engine` and produce the root package plus its matching native
companion with `bun run package:release`. Publish those generated archives from
the release workflow; publishing the source tree directly is intentionally
blocked because it would omit companion assets on other platforms.
