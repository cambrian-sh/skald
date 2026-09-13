# Skald comparison and ship audit

Audit date: 2026-09-13

This document compares the independent Skald product with the current Cambrian
memory implementation, Afşin's codebase-memory-mcp work, and the original
project-context vision. Skald is one product and one installation/lifecycle
boundary. It embeds Afşin's native structural engine as its internal execution
component rather than asking developers to assemble or locate a second product.

## Sources inspected

- Afşin's repository: `/home/doruk/Code/cambrian/codebase-memory-mcp`
- Afşin's requested commit: `cf1d310a72320ec55e7b86a091561162567e55d2`
- Cambrian knowledge repository: `/home/doruk/Code/cambrian-knowledge`
- Cambrian knowledge HEAD observed during audit:
  `940913931bed0bb930c357f9fc9e01e4c867f346`
- Skald product vision: [`product.md`](product.md)
- Skald implementation: [`src`](src)

The Cambrian reference worktrees contained substantial pre-existing uncommitted
changes. This audit also repaired the knowledge repository's duplicate ADR
identifier and stale/missing verification references; those repairs are mixed
with the pre-existing worktree changes and must be reviewed before commit.

The exact requested Afşin commit contains the `src/pipeline/pass_knowledge.c`
knowledge-pipeline implementation and its related pipeline/YAML changes. It
does not expose a separate MCP `index_knowledge` tool in its 16-tool registry;
Skald therefore owns the sync/reconcile orchestration and invokes the public
`index_repository` contract after synchronization.

The official staged Linux asset at
`vendor/engine/linux-amd64/codebase-memory-mcp` is the root binary from the
exact Afşin commit. Its SHA-256 is
`e872396e13442358e6f677aff1b33df732d74797625b87db0f27dbb42212dafe`, and the
manifest records the source repository and commit. The separate
`/home/doruk/.local/bin/codebase-memory-mcp` 0.8.1 binary is not used by the
official path.

## Capability comparison

| Capability | Afşin / Cambrian engine | Skald now | Assessment |
| --- | --- | --- | --- |
| Structural code graph | Native C engine, typed extraction, LSP-assisted resolution, graph queries, search, tracing, architecture, change impact | Capability-negotiated MCP client; invokes the advertised subset of `index_repository`, `list_projects`, `search_graph`, `search_code`, and `get_architecture` | Correct separation; Skald does not duplicate the engine |
| MCP surface | 16 tools in the requested Afşin registry, stdio server, daemon and watcher lifecycle | Product-owned `skald-context` MCP plus a capability-negotiated backend entry | Agents receive both context/memory and full graph capability; the adapter does not hard-code a stale tool count |
| Indexing | Fast, moderate, full, incremental behavior, persisted graph artifacts | `setup`, `init`, `engine index`, `knowledge index`, and `project_refresh`; records engine digest, Git revision, backend coverage, and bounded run history in `.skald/state.json`; clean revision drift refreshes automatically on context query by default, while dirty worktrees require explicit refresh | Working local-first lifecycle; a long-lived daemon is unnecessary because Afşin's engine owns watcher/daemon behavior |
| Knowledge files | ADRs, decisions, components, contracts, investigations, research; YAML frontmatter; freshness and artifact relationships | Reads those Cambrian directories, parses the contract index, merges local session records, excludes superseded/retired records from usable context, reconciles revision and artifact evidence, applies supported status upgrades, and keeps bounded symlink-safe source attribution | Compatible read and synchronization path; writes are explicit and canonical roots are never touched implicitly |
| Knowledge freshness | Revision anchors, dates, bounded propagation through related artifacts | Fresh/stale/unknown classification; warns on missing anchors and old canonical records | Conservative compatibility layer; engine remains authority for graph freshness |
| Session memory | Engine and Cambrian knowledge conventions support durable records | `memory record` and `record_project_knowledge` write deduplicated session-authority records for all Cambrian kinds under `.skald/knowledge`; `memory review`, `promote`, and `reject` govern the transition to canonical knowledge with conflict blocking | Safe by default; promotion is explicit and auditable |
| Agent setup | Afşin installer has broad client/profile support | Capability registry for Claude Code, Codex global opt-in, and OpenCode; JSON/JSONC/TOML safe merging; optional Claude SessionStart hook | Satisfies the selected v1 clients and preserves legacy Cambrian entries |
| Standards discovery | Agent installer surfaces and generated instruction profiles | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Copilot instructions, Cursor rules, `.skills`, and common skill roots | Good portable baseline; instruction generation remains opt-in/future |
| Retrieval | Rich structural, semantic, cross-repository and graph queries | `project_context` combines instructions, skills, knowledge, and capability-selected backend graph/search results with path and character budgets | Useful default context surface; advanced queries remain available on backend MCP |
| Safety | Native engine scope, process, and cache controls | Descriptor-safe managed paths on Linux/macOS/BSD, no-follow symlinks, atomic writes, bounded discovery/input, MCP deadlines, user-scoped command/argument/digest trust, private Afşin runtime rendezvous, and external-knowledge approval | Strong setup boundary; unsupported managed-path platforms fail closed and repository config cannot authorize execution |
| Distribution | Native binary, daemon, graph UI, installer/update path | Standalone Bun builds embed the pinned Afşin asset; the published `@cambrian/skald` package installs a matching platform companion; `setup` atomically installs it into project-local `.skald/engine/`, verifies the complete contract, and records its digest; release artifacts include checksums and GitHub build attestations | Linux amd64 package and standalone paths are proven; the release matrix still needs executed multi-platform conformance and a publisher release baseline |

## What was wrong and is fixed

The implementation review found and fixed these release-blocking issues:

1. Existing Claude/OpenCode configs could receive the backend but silently omit
   `skald-context` because two in-memory additions were persisted through one
   JSONC edit. JSONC updates now apply every staged edit sequentially and keep
   unrelated servers/comments.
2. A non-responsive MCP backend could hang `init` or `doctor` forever. MCP
   initialize/tool calls now have a bounded deadline, kill and reap the child,
   and return a useful machine-readable failure detail. The deadline is
   configurable through `SKALD_MCP_TIMEOUT_MS` within safe bounds.
3. `bunx @cambrian/skald init` could persist a temporary, unresolved `skald` command for
   the context server. Generated project adapters now point to a bundled
   `.skald/context-runtime.mjs`, which remains runnable after the package
   manager cache changes; an explicit no-install fallback is reported when
   bundling is unavailable.
4. Context retrieval was only local-file retrieval. It now resolves the
   configured indexed backend and adds an architecture overview or relevant
   `search_code` result, with an explicit warning when indexing is unavailable.
5. Context MCP input had no line-size bound. Oversized MCP requests are
   rejected at the 1 MB boundary instead of allowing unbounded buffering.
6. The project check accidentally linted `.omo` tool-state evidence artifacts.
   Tool state is excluded from product linting; source typecheck, lint, tests,
   build, and packaging remain checked.
7. The knowledge reader's 1 MiB aggregate cap truncated the real Cambrian
   repository after roughly 51 records. The bounded cap is now 16 MiB; the
   current Cambrian tree is verified at 213 recognized records, including the
   contract index, with `truncated: false`.
8. MCP cleanup originally waited forever after a cooperative termination
   request. Cleanup now escalates to SIGKILL and bounds both child reaping and
   stderr draining; a regression test covers a backend that ignores SIGTERM.
9. Backend subprocesses inherited the complete parent environment, captured
   unbounded output, and could leave descendants alive. Skald now uses an
   explicit environment allowlist, bounded stdout/stderr capture, detached
   process-group cleanup, and Windows tree-kill support.
10. Initialization could execute a repository-local binary merely because it
    matched a conventional path. Implicit local engines are now discovery-only;
    `--mcp-command` records explicit trust for later context retrieval.
11. Managed writes used pathname checks followed by pathname mutations. POSIX
    writes now resolve every directory through stable handles and publish new
    files through a fully written hard link, eliminating the tested symlink race
    and partial-file window.
12. Context retrieval returned sources in discovery order without a shared
    budget. Skald now applies deterministic relevance ordering and reports its
    character budget and truncation state.
13. Context retrieval selected Afşin tools from a filename heuristic and could
    not adapt to a compatible backend's actual surface. Skald now asks for
    `tools/list` and selects only advertised retrieval capabilities, while
    retaining a conservative Afşin fallback for older servers.
14. A clean Git revision could still hide a changed structural engine. Freshness
    now compares the current adopted engine digest with the digest recorded for
    the index run and degrades safely when it cannot be verified.
15. Backend coverage metadata could be silently treated as a perfect index.
    `skipped` and `parse_partial` coverage now mark the recorded index degraded.
16. The session writer exposed only four of the Cambrian knowledge kinds. It now
    supports components, contracts, investigations, and research as well as
    ADRs, decisions, observations, and measurements.
17. Repeated session writes accumulated identical discoveries. Session records
    now use deterministic content fingerprints and return an idempotent
    `exists` receipt.
18. External canonical knowledge made local session records invisible. Context
    and doctor now merge the project-local session lane with the configured
    canonical directory.
19. Capability negotiation checked only tool names and could send unsupported
    arguments. Skald now filters generated arguments against advertised input
    schemas and asks Afşin for index status and scoped coverage when available.
20. A trusted engine pathname could be replaced after attestation and before
    spawn. Pinned invocations now execute a freshly verified private snapshot
    and remove it after the process exits.
21. Afşin's default daemon rendezvous could collide with a stale account daemon,
    or a long custom parent could exceed Unix socket path limits. Skald now
    supplies a project-and-engine-scoped `.skald/r` runtime when its absolute
    path is safe, and a deterministic short private OS-runtime rendezvous for
    oversized roots, while preserving explicit values.
22. Managed-file safety had a pathname-based fallback on platforms without
    descriptor traversal. That fallback is removed; Skald now fails closed
    before managed reads or writes on unsupported platforms.
23. Repository manifests and existing agent configuration could previously be
    mistaken for execution authority. Skald now requires a user-scoped trust
    record for backend execution; explicit commands create that record, while
    repository-controlled `trust` and digest fields are only evidence to check.
24. A trusted binary could be invoked with changed arguments or with an
    arbitrary environment injected through a repository config. Trust records
    now bind the exact argument vector, persisted configs accept only the
    supported backend environment, and generated agent configs omit untrusted
    backend entries while retaining the Skald context server.
25. External `CBM_KNOWLEDGE_DIR` paths could be read merely because a project
    named them. Skald now allows project-local roots automatically and requires
    explicit user approval for external roots; session memory remains available
    when canonical external knowledge is unavailable.
26. Trust registry updates could lose concurrent approvals. User-scoped trust
    updates now retry around atomic concurrent-file conflicts and verify the
    resulting entry.
27. Persisted context sources could drift from an explicitly configured
    `CBM_KNOWLEDGE_DIR`. Existing JSONC manifests now update only the targeted
    knowledge source path while preserving comments and unrelated fields.
28. A fresh developer still had to locate Afşin's native engine manually.
    `setup` now installs the embedded, pinned Afşin asset into `.skald/`,
    verifies the complete contract, records its digest, and adopts it for the
    project. `init` remains the offline configuration path when an engine is
    already present or a custom backend is intentionally supplied.
29. A stale trusted graph could be used indefinitely after the repository
    changed. The default `onQuery: refresh` policy now performs a bounded fast
    refresh before structural retrieval when clean revision drift is detected,
    avoids repeated indexing in dirty worktrees, and records whether the run was
    setup, manual, or automatic.
30. Session discoveries had no governed path into canonical project memory.
    Review, explicit promotion, conflict detection, revision anchoring, and
    rejection now provide a durable decision boundary without mutating
    configured canonical roots.
31. Agent integration behavior was spread across client-specific branches and
    Claude had no optional session-start context injection. A capability
    registry now describes supported surfaces, and `--hooks` installs an
    idempotent, preserved Claude SessionStart hook.
32. Re-running setup could leave an old project-local context runtime that did
    not contain new Skald behavior. Runtime publication now refreshes an
    existing generated runtime atomically and reports `updated`.
33. Managed installation accepted exact package versions that were not backed by
    checked-in integrity metadata, which still allowed install lifecycle code to
    run before provenance was established. The managed path now fails closed for
    unknown versions; each supported release must have an archive integrity pin.
34. The archive-size guard previously ran after loading the entire HTTP response
    into memory. Pinned downloads now stream to a private staging file, hash each
    chunk, and abort at the 64 MiB boundary.
35. Generated context launchers used bare `bun`/`bunx`, leaving interpreter
    selection to mutable `PATH`. Generated MCP entries and Claude hooks now use
    absolute executables and project-local absolute runtime paths.
36. Compiled standalone setup could fall back to an absolute path inside the
    original launcher location. It now publishes a private executable copy under
    `.skald/context-runtime` and configures clients to launch that copy.
37. The manifest type exposed `beforeWrite: warn` but validation rejected it,
    making the documented policy choice unusable. Manifest validation and tests
    now support both `warn` and the strict default `require-verify`.
38. Automatic stale refresh could repeatedly re-index a dirty worktree because
    every successful refresh correctly remained stale while uncommitted files
    existed. Automatic refresh now runs only for clean revision drift; dirty
    worktrees receive an explicit warning and require `project_refresh`.
39. The final client path audit found Codex's global backend entry could bypass
    Skald's supervised `backend` proxy even though Claude and OpenCode used it.
    Trusted Codex installation now routes the backend through Skald's verified
    runtime as well; a regression test covers the generated TOML.
40. Package QA now builds and installs the actual packed archive in an isolated
    consumer, invokes the packaged CLI, initializes a project, and starts the
    generated MCP runtime. This closes the source-tree-only distribution gap.
41. Dirty-worktree freshness now excludes Skald-managed Claude hook settings;
    generated client files no longer make a clean source tree appear stale.
42. Managed text writes and descriptor reads now enforce byte limits during the
    operation, including files that grow concurrently, while standalone binary
    publication retains a separate bounded 512 MiB allowance for Afşin's native
    asset.
43. Initialization now completes configuration and engine preflight before
    publishing project integration. A failed initial index leaves no project
    manifest, client configuration, context runtime, or user trust approval.
44. The context MCP server now rejects malformed JSON-RPC envelopes with the
    standard invalid-request error instead of accepting missing or wrong
    protocol versions.
45. Afşin compatibility was previously only checked through a minimum
    capability probe. Skald now has an explicit complete-contract gate that
    verifies all 16 tools from the requested `cf1d310` registry and the
    required input fields in their advertised JSON schemas. Its optional
    `--smoke` mode exercises the safe read-only operations against an indexed
    project, including status, coverage, schema, architecture, graph search,
    code search, Cypher, graph comparison, change detection, ADR reading,
    tracing, and source snippets.
46. Cambrian's knowledge synchronization and reconciliation were previously
    external to Skald. Skald now owns an explicit Cambrian-compatible
    implementation of revision-anchor reconciliation, stale artifact detection,
    broken supersession-chain detection, duplicate identifiers, evidence-based status
    upgrades, safe metadata synchronization, and post-commit automation.
    `knowledge index` provides the complete sync-then-index lifecycle using
    Afşin's public `index_repository` contract because the requested Afşin
    registry does not expose a native MCP `index_knowledge` tool.

## Original vision coverage

The original promise was “Your project is remembered.” The current product
delivers the core local loop:

```text
discover -> configure -> index -> retrieve -> record session knowledge
```

It is project-local, conservative, standards-aware, compatible with Cambrian's
`CBM_KNOWLEDGE_DIR`, and simple enough to run with one setup command that
provisions the embedded Afşin backend. The internal MCP boundary remains a
transport and compatibility contract, not a second developer dependency. It
does not claim that a coding agent will obey
any instruction file that its client does not load; the MCP server's initialize
instructions and generated `.skald/context.md` are guidance, while client
behavior remains client-owned.

## Residual product work

The local-first workflow is technically verified as a release candidate, but
publication still requires a committed/tagged baseline and package-owner release
process. Remaining work is release breadth and evidence rather than a missing
core loop:

- signed, platform-specific native assets for every supported target, generated
  from and checked against the pinned Afşin commit;
- more client adapters and client-specific instruction injection where their
  APIs support it;
- Windows/macOS/BSD conformance runs and migration fixtures;
- optional background scheduling for teams that want proactive indexing rather
  than refresh-on-query;
- richer change/session retrieval and measurable context-quality benchmarks.

The Cambrian knowledge repository's reconciliation behavior is covered by
Skald's portable knowledge commands and hooks, and its actual duplicate-ID and
verification-anchor defects were repaired during this audit. Afşin's exact
commit contains the lower-level knowledge pipeline, but its MCP registry has no
native `index_knowledge` operation; Skald's `knowledge index` lane is the
supported product-level equivalent.

During this audit, a clean archive of Afşin commit
`cf1d310a72320ec55e7b86a091561162567e55d2` was built outside the reference
worktree. Its executable SHA-256 was
`66b55f596d46531efd945933c90c45588c673529b9e766d371e0ca9390e0cb12`.
Skald's complete contract gate and read-only smoke gate both passed against
that clean build. This is semantic/runtime evidence, not a publisher signature
or a substitute for a future signed release asset.
The legacy managed npm `codebase-memory-mcp@0.10.8` channel remains available
only for explicit compatibility use. It is not selected by `setup` and is not
the official engine.

## Release conclusion

The current working tree is a technically verified local-first release candidate
pending a committed/tagged baseline. The embedded Linux asset has passed the
complete Afşin contract gate, compiled standalone setup with real indexing, and
the packed-consumer loop. Skald is a monolithic developer experience: it owns
setup, lifecycle, context, memory, safety, knowledge automation, and adapters,
while Afşin's native engine is shipped inside that same product as the isolated
structural-analysis component. The trust boundary remains explicit: repository
configuration can describe a backend, but only the official setup path or a
user-scoped approval can authorize execution.
