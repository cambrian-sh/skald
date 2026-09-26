# Skald Product Context

## Product definition

Skald is a project context and memory layer for coding agents.

It gives AI coding agents a durable understanding of a software project:
structure, conventions, instructions, architectural decisions, dependencies,
history, and accumulated knowledge. Instead of treating every agent session as
if it starts from zero, Skald helps the agent enter a project with context.

Skald is designed for developers using agents such as Claude Code, Codex, and
OpenCode.

The simplest product promise is:

> Your project is remembered.

## The name

“Skald” comes from the Nordic tradition of the skald: a poet, storyteller,
historian, and keeper of cultural memory.

A skald did more than write poetry. Skalds preserved stories, lineage,
decisions, battles, values, and identity. They carried knowledge forward so
the present could act with awareness of the past.

That maps directly to the product:

> Skald is the memory keeper of a codebase.

A software project also has a story:

- why it was designed a certain way;
- which decisions shaped its architecture;
- where important logic lives;
- what conventions contributors follow;
- which integrations and boundaries must not be broken;
- what previous agents and developers already discovered;
- how the system has evolved over time.

Skald makes that story available to coding agents.

## The problem

Modern coding agents are powerful but often context-poor. They can read files,
search repositories, and execute commands, but they do not automatically retain
a coherent model of a project.

Developers repeatedly have to explain:

- the architecture;
- the important repositories;
- the project vocabulary;
- which files are authoritative;
- which decisions are load-bearing;
- what must not be changed;
- how the agent should behave;
- what previous sessions already learned.

This creates repeated explanation, shallow or incorrect changes, forgotten
architectural decisions, inconsistent agent behavior, duplicated
investigation, context-window waste, and fragile onboarding.

Skald addresses this by making project context a persistent, discoverable,
structured layer.

## What Skald does

At the product level, Skald is intended to:

1. Discover a project and its boundaries.
2. Detect existing agent instructions and conventions.
3. Understand project-local standards such as AGENTS.md, CLAUDE.md, skills,
   rules, and other agent configuration.
4. Ship and supervise the official Afşin codebase-memory engine through an
   internal MCP transport boundary.
5. Index the project into a searchable structural knowledge graph.
6. Retrieve relevant context when an agent is working.
7. Preserve architectural knowledge, decisions, and discoveries across
   sessions.
8. Remain compatible with existing custom Cambrian infrastructure and the
   codebase-memory-mcp engine.

The product relationship is:

> Afşin's engine supplies native structural intelligence. Skald turns it into
> a complete, project-local context and memory product.

## Current implementation

Skald is an independent project under the Code workspace. It is implemented in
TypeScript and runs on Bun.

The current working tree is a technically verified local-first release
candidate, not yet a public release. The official native target matrix is Linux
amd64/arm64 and macOS arm64/amd64. Windows and BSD do not have bundled Afşin
engine releases and are not supported setup targets; Windows managed writes
fail closed. The local Linux amd64 setup/index/context path is verified, while
the four-target release workflow has not yet run. The CLI can:

- discover the nearest Git project;
- report existing agent instruction files and portable skills;
- create a versioned project-local .skald/config.json manifest;
- configure project-local MCP integration for Claude Code and OpenCode;
- expose a Skald-owned context MCP server with ranked project context, health,
  bounded retrieval, and session-memory tools;
- perform a bounded, supervised MCP stdio handshake with compatible backends and
  negotiate advertised capabilities, then run an initial index only after the
  backend has been user-trusted;
- install the bundled or platform-companion Afşin `codebase-memory-mcp` asset into `.skald/engine/`,
  verify its pinned commit and complete 16-tool contract, and retain its
  digest in project state;
- create a managed `.skald/.gitignore` block so local engines, graph/cache
  state, launchers, and unreviewed session memory do not become accidental Git
  artifacts, while promoted canonical knowledge remains shareable;
- combine Afşin's graph and code search capabilities when available, with
  conservative fallback for compatible MCP backends;
- record engine digest, Git revision, working-tree state, and degraded coverage
  in `.skald/state.json`, refresh stale trusted indexes automatically on the
  first context query when the worktree is clean, and retain bounded
  setup/manual/automatic run history; dirty worktrees require explicit refresh;
- discover and source-attribute canonical Cambrian knowledge through
  CBM_KNOWLEDGE_DIR;
- create deduplicated, reviewable session records in .skald/knowledge for the
  complete Cambrian knowledge taxonomy;
- review, promote, conflict-check, or reject session records without mutating
  configured canonical knowledge roots;
- diagnose project, backend, standards, knowledge, and index health;
- support .agents/skills, .skills, .claude/skills, .opencode/skills,
  .github/skills, and legacy Cursor rules;
- preserve existing agent configuration;
- preserve legacy codebase-memory-mcp entries;
- report when the installed Codex CLI requires global configuration;
- install Codex globally only through an explicit command;
- install an opt-in Claude SessionStart hook that injects bounded,
  source-attributed context while preserving existing hook configuration.

The primary one-command path is:

    skald setup

`setup` is the one-command path for a new project. `init` remains the offline
configuration lifecycle when the official asset is already present or a custom
backend is intentionally supplied; use `--no-index` when only configuration is
wanted.

It creates or safely merges:

- .skald/config.json;
- .skald/context.md;
- .mcp.json for Claude Code;
- opencode.json or opencode.jsonc for OpenCode.

The default launcher is the bundled or platform-companion Afşin engine pinned to
`cf1d310a72320ec55e7b86a091561162567e55d2`. Persistent engine state stays under
`.skald/`; `.skald/r` is used for the daemon rendezvous whenever its absolute
path fits the Unix-socket limit, with a deterministic private OS-runtime
fallback for unusually deep project roots. No `--mcp-command` or
`CBM_KNOWLEDGE_DIR` is needed for the default path. Custom engines and external
knowledge roots remain supported through explicit flags. Repository
configuration can describe a launcher, but cannot authorize Skald to execute
it. An explicit command is recorded in a user-scoped trust registry together
with its project, arguments, and digest.
Initialization also compiles `.skald/context-runtime.mjs` and configures the
project clients with absolute Bun and runtime paths, so the context server
remains available after package-manager cache or `PATH` changes. A compiled
standalone launcher copies itself to `.skald/context-runtime` when source
bundling is unavailable.

Trusted project backend entries use the generated runtime's `backend` command so
client-launched structural retrieval remains under Skald's digest and trust checks.

Codex currently does not consume project-local MCP configuration in the
installed CLI. Skald therefore leaves Codex global configuration untouched
during init. The explicit fallback command is:

    skald agents install codex --global

That command preserves existing Codex settings and legacy server entries.
Codex support is therefore global opt-in only in the current CLI; it is not a
project-local adapter like Claude Code and OpenCode.

New configuration uses the product-facing server key skald and the
project-context server key skald-context. Existing codebase-memory-mcp entries
are recognized as compatible legacy configuration and are not duplicated or
overwritten. The context server is added alongside them so existing Cambrian
backends remain active.

## Relationship to Cambrian

Skald must remain compatible with the existing Cambrian solution. Cambrian is a
larger multi-repository system with its own kernel, knowledge repository,
agent SDK, UI, CLI, and operational conventions.

Skald should provide a clean product and developer-experience layer around
those capabilities without rewriting or tightly coupling itself to Cambrian's
internal repositories. In the final design, this is a modular monolith from a
developer's perspective: one Skald command, one project contract, one managed
lifecycle, and one context surface. The native graph engine is an internal
structural-analysis subsystem, not a second setup experience the developer must
assemble by hand.

Skald's structural compatibility contract is the complete 16-tool MCP and
required-input schema surface exposed by Afşin's
`codebase-memory-mcp` implementation. The pinned Afşin asset is the official
default; custom MCP engines may be adopted explicitly when a project needs
them. The engine provides the native codebase knowledge graph and tool surface.
Skald owns project discovery, configuration adapters, profiles, context
selection, memory records, trust policy, storage, and lifecycle management.
The agent-facing product remains one monolith even though the native parser and
graph subsystem is an isolated executable inside the package.

This separation is important:

- the engine can evolve independently;
- Cambrian's custom solution remains valid;
- Skald can support other memory backends later;
- developers do not need to understand Cambrian's repository layout to use
  Skald;
- project-local configuration remains portable and reviewable.

Cambrian compatibility includes a portable knowledge lifecycle. Skald can
consume an approved `CBM_KNOWLEDGE_DIR`, preserve canonical records, reconcile
supersession and revision evidence, synchronize verification metadata, apply
Cambrian's evidence-based proposed/accepted-to-implemented transition, and keep
local session memory separate. `knowledge index` then runs the sync lane before
indexing the configured backend. This replaces the setup burden represented by
Cambrian's reconciliation workflow and documentation. Afşin's requested baseline does not
expose a native `index_knowledge` MCP tool, so Skald implements the equivalent
portable lifecycle through the public `index_repository` contract rather than
claiming a native fast path that is not present.

## Product flow

The intended user flow is:

    project -> discovery -> managed engine -> indexing -> memory -> retrieval -> agent action

In practical terms:

1. A developer installs Skald.
2. They run one setup command in a project.
3. Skald discovers the project and its existing agent standards.
4. Skald provisions or adopts a verified compatible engine and connects the
   Claude Code and OpenCode clients to the managed context surface; Codex
   requires explicit global opt-in.
5. The engine maps the project and exposes structured knowledge.
6. Agents retrieve relevant context while planning and changing code.
7. New discoveries and decisions can become part of the project's durable
   memory.

## Target users

### Individual developers

Developers who use coding agents daily and want agents to understand their
projects without repeating the same explanations.

### Teams

Teams that need shared project context, consistent agent behavior, durable
architectural knowledge, and easier onboarding.

### Maintainers of large codebases

People working in repositories where the important knowledge is distributed
across code, documentation, configuration, architectural records, and history.

### Agent and platform builders

People building custom coding-agent workflows who need a standard context and
memory layer rather than a one-off integration.

## Product principles

### Context before action

An agent should understand the relevant project context before proposing or
making changes.

### Durable knowledge

Important decisions and discoveries should survive the end of a session.

### Project-local by default

Configuration should live with the project whenever the client supports it.
Global changes should be explicit and justified.

### Preserve existing work

Skald should merge conservatively, never overwrite a developer's existing
agent configuration, and remain compatible with legacy setup.

### Standards-aware

Skald should recognize widely adopted agent conventions rather than inventing a
closed replacement for them.

### Small, fast, and understandable

The setup experience should be simple enough to run immediately, while the
underlying system remains configurable for advanced users.

### Backend-independent

The product should not make developers depend on one particular memory engine
forever. The current codebase-memory-mcp integration is the first structural
subsystem, not the final product limitation. Backend independence belongs
behind a stable Skald context contract, so changing engines does not change the
developer or agent integration.

## Release-critical product direction

Before the first public release:

- remove the oversized engine blob from the unpublished local Git history and
  publish a clean repository baseline;
- bootstrap the first five npm packages and configure trusted publishers;
- run the native build, standalone, conformance, and consumer gates on all four
  supported Linux/macOS targets.

After that release gate, the product roadmap is:

- project profiles for Cambrian and other backends;
- portable Windows/BSD setup and native engine support;
- publisher signatures/notarization in addition to the current checksums and
  GitHub artifact attestations;
- richer backend query and retrieval policies;
- richer change/session retrieval and context-quality benchmarks;
- more client adapters, migration fixtures, and cross-platform conformance;
- optional proactive background scheduling for teams that want it;
- optional local UI or diagnostics without making a TUI mandatory.

## Positioning

Practical positioning:

> Skald gives coding agents a durable memory of the projects they work on.

Expressive positioning:

> Skald turns a codebase from a pile of files into a remembered world.

Developer-experience positioning:

> Install Skald once, and your coding agents can enter every project with the
> right context.

## Useful language

Prefer:

- project memory;
- codebase context;
- remembered project;
- architectural lineage;
- durable knowledge;
- context layer;
- knowledge graph;
- connected understanding;
- project story;
- memory keeper.

Use carefully:

- AI;
- intelligence;
- automation;
- agent memory.

Avoid making the product sound like:

- a generic chatbot;
- a personal note-taking app;
- a fantasy game;
- a Viking-themed novelty;
- a surveillance system;
- an omniscient AI;
- a replacement for developers.

## Product essence

Skald helps agents remember what developers already had to learn the hard way.

It preserves the structure, decisions, conventions, and evolving story of a
codebase so agents can work with context instead of starting from zero.
