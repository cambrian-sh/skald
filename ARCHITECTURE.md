# Skald architecture

Skald is a monolithic product for project context and memory. One package owns
the setup command, project contract, lifecycle, storage boundary, context
surface, agent adapters, and the official Afşin structural engine asset. The
native engine runs as a supervised subprocess because that is the safe isolation
boundary for a C server with its own parser, graph store, daemon, and watcher;
the developer still installs and operates one product.

## Product boundary

```text
coding agent
    |
    v
Skald context + memory runtime
    |-- source discovery and standards
    |-- durable knowledge and session memory
    |-- freshness and change reconciliation
    |-- retrieval ranking and context budgeting
    |-- agent adapters and setup
    |-- diagnostics, trust, and lifecycle
    |
    v
managed structural engine
    |
    `-- Afşin's native codebase-memory-mcp today
```

The official one-command release matrix is Linux amd64/arm64 and macOS
arm64/amd64. Windows and BSD are not currently packaged or validated release
targets; the managed filesystem layer fails closed where descriptor-safe
operations are unavailable. MCP is an internal transport and an external
compatibility surface. Skald verifies the complete 16-tool Afşin registry and
required input schemas, and offers a separate read-only semantic smoke gate for
an indexed project. A developer should not have to assemble multiple unrelated
tools to get a working project memory system.

## Skald-owned subsystems

### Runtime and engine management

Skald locates, attests, starts, supervises, and diagnoses the native structural
engine. Repository-local binaries are never executed implicitly. `setup` stages
the release's pinned Afşin asset into `.skald/engine/codebase-memory-mcp`,
verifies its complete contract, and records its SHA-256 and commit. Cache,
configuration, and knowledge default to `.skald/`; `.skald/r` is the runtime
rendezvous when its absolute path is safe, while unusually deep roots use a
deterministic private OS-runtime directory to stay within Unix socket limits.
The managed `.skald/.gitignore` keeps engine binaries, cache/runtime state, and
unreviewed session records out of Git while preserving promoted canonical
knowledge as a shareable project artifact. Release CI builds native engine
assets from Afşin's pinned source; `.gitignore` prevents new staged binaries
from being added but cannot remove a blob already present in Git history.
Skald's small first-party Node-API helper provides only no-follow,
descriptor-relative filesystem primitives; TypeScript retains bounded reads,
atomic writes, and policy. The helper is built for each native release target,
shipped in the matching existing engine companion, and embedded in standalone
executables. Missing helpers fail closed; there is no pathname-based fallback.
Custom external knowledge roots remain explicit and user-approved. A custom backend is
replaceable behind the Skald context contract but is never the official default.
Initialization also publishes a project-local Skald context runtime with
absolute launcher paths, keeping agent configuration independent of a transient
package-manager cache and mutable `PATH`.

### Source and standards inventory

Skald discovers repository boundaries, `AGENTS.md`, `CLAUDE.md`, other widely
used instruction files, skills, rules, agent configuration, canonical knowledge
repositories, and project metadata. Every surfaced item keeps its source and
authority.

### Knowledge and memory substrate

Skald owns a structured local memory surface for decisions, observations,
measurements, investigations, components, contracts, and session discoveries.
Records carry provenance, authority, freshness, status, and source references.
Session records are reviewable and never silently promoted to shared truth.

### Structural understanding

Afşin's engine owns parsing, tree-sitter grammars, hybrid LSP resolution,
semantic/BM25/graph retrieval, SQLite persistence, call graphs, architecture,
impact analysis, daemon coordination, watchers, and its native UI. Skald
discovers the backend's advertised MCP tools, consumes the available structural
capabilities through a bounded compatibility client, and exposes the useful
results through its own context compiler.

### Context compiler

Skald combines local standards, durable knowledge, session memory, and relevant
structural results. Selection is deterministic, source-attributed, freshness-
aware, relevance-ranked, and bounded by a context budget. A missing backend
degrades to local context with an explicit warning; it never fabricates graph
knowledge.

### Agent adapters

The adapter layer configures Claude Code, Codex, OpenCode, and future clients
through their native standards and configuration shapes. It preserves existing
entries, uses capability negotiation, avoids global writes by default, and
provides one stable `skald-context` surface. Codex is currently a global opt-in
adapter because the installed CLI does not consume project-local MCP settings.

### Automation and lifecycle

The current product reconciles each index run with code revision, working-tree
state, engine identity, and backend coverage. A stale trusted index is refreshed
on the first context query by default when the worktree is clean; dirty
worktrees require explicit refresh to avoid repeated indexing while files are in
flight. The state file retains bounded run history. Session knowledge has an
explicit review, promotion, conflict, and rejection path. Operations remain
bounded and crash-safe at the managed-file publication boundary; the observable
states are `fresh`, `stale`, `degraded`, and `unknown`.

Knowledge automation is also Skald-owned: `knowledge reconcile` detects broken
identifiers, supersession chains, revision anchors, stale artifacts, and
unverified repositories; `knowledge sync --write` updates verification fields
and evidence-based status upgrades; `knowledge index` performs sync followed by
backend indexing. Optional Git hooks connect source commits to sync and
knowledge commits to the indexing lane.

## Non-negotiable quality invariants

- One-command setup for a new developer on supported platforms.
- No hidden network calls, secret persistence, or implicit execution of
  repository-controlled programs.
- Every context item has an authority, freshness state, and source reference.
- Context assembly is deterministic and bounded; omissions are observable.
- Freshness is revision-aware, not an arbitrary age-only guess.
- Session discoveries remain distinct from canonical project truth.
- Existing agent configuration and Cambrian's `CBM_KNOWLEDGE_DIR` remain
  compatible.
- Superseded or retired canonical knowledge is never presented as usable
  project guidance.
- Failure is explicit and degradable: no empty-success response and no
  unbounded process, memory, or file operation.
- Managed filesystem operations fail closed on platforms without descriptor-safe
  directory traversal.
- Repository-controlled backend trust flags and external knowledge paths never
  grant execution or read authority; those approvals are user-scoped.
- The native engine may evolve independently without changing the agent-facing
  Skald contract.
- Project client backend entries launch through Skald's verified runtime when a
  digest-pinned backend is configured; legacy direct entries are preserved rather
  than rewritten.
- Afşin conformance is observable through the CLI: surface/schema checks are
  complete, while smoke mode deliberately excludes destructive index deletion
  and trace-ingestion mutations.

## Release sequence

The local Linux amd64 source and standalone flow has been exercised. A tagged
four-target release, registry publication, native consumer matrix, and public
repository baseline are still pending. The current release boundary is Linux
and macOS; Windows/BSD support, proactive scheduling, broader adapters, and
context-quality benchmark evidence remain roadmap work.

The product claim to validate across every release target is:

> Install Skald, run one command, and an agent can work from precise,
> attributable, current project context without hand-built integration.
