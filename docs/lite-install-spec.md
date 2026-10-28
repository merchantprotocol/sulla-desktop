# Sulla Lite install mode

**Status:** design and prototype plan

**Scope:** additive install mode; no application refactor in this proposal

**Target:** a first useful chat in minutes, without a Linux VM, Docker, or service containers

## Decision

Sulla Lite should be a distinct runtime profile selected during onboarding, not a second product and not a degraded Full boot. It keeps the Electron UI and extension contracts, then replaces container-backed infrastructure with native, least-privilege adapters. The profile is persisted as `runtimeProfile: "lite" | "full"`; feature code asks a capability registry what is available instead of inferring availability from a failed container connection.

Lite's first shippable slice is deliberately narrow: chat, skills, signed integrations, and deterministic workflows whose nodes are all Lite-capable. Recipes, arbitrary functions, delegated/container agents, server mode, and direct access to user-selected host files require Full. The UI must label these states **Needs Full** before installation or execution. It must never simulate a successful install, silently omit a workflow node, or fall back to running untrusted code in Electron.

The security boundary is non-negotiable in both profiles:

- Agents never receive vault plaintext or vault keys. Integrations receive opaque grants, and a trusted broker injects credentials into an outbound request.
- Agents never receive host paths or direct host filesystem access. User files remain behind the Files service and its permission, identity, version, audit, lock, and retention checks.
- Electron renderer processes remain untrusted. Native Lite services run outside renderers with authenticated, narrow IPC/RPC contracts.
- Lite is not described as NIST SP 800-171 compliant. It preserves the current engineering direction and must produce deployment-specific evidence before any compliance claim.

## What Full boots today

The current startup path is coupled at two layers.

First, `SullaRuntimeBackend` boots the native Linux VM, mounts explicitly configured virtio-fs shares, waits for Docker, configures the Docker client and port forwarder, generates Compose, starts managed services, and only then calls `instantiateSullaStart()`. `ServiceLifecycleManager` subsequently starts the Desktop-side dependency graph. The graph has independent services, but its application layer is gated by `postgres`, `redis`, and `database-manager`; vault-gated services wait for unlock. This is why simply skipping VM startup does not produce a usable Desktop.

Second, the generated Compose stack is larger than the base YAML suggests. The checked-in base defines Postgres, Redis, and on-demand Python, shell, and Node function runtimes. `SullaRuntimeBackend.prepareSullaComposeFile()` adds Accounts, Vault, workflow manager, relay, tools, Files, Files FUSE, and threat proxy services. Workflow executions and delegated agents can launch further containers.

The dependency map below distinguishes a physical dependency from a current implementation dependency.

| Capability | Current dependency and code path | Why it needs the VM today | Lite disposition |
|---|---|---|---|
| Core records: chats, messages, settings, model providers, skills, workflow definitions/executions, integration metadata, marketplace installs | `PostgresClient`, `DatabaseManager`, model classes and migrations; lifecycle `postgres -> database-manager` | PostgreSQL is a Compose service on host port 30116 and most models speak PostgreSQL SQL directly | Native SQLite adapter, schema described below |
| Coordination/cache | `RedisClient`; heartbeat, model-provider cache, workflow stop/pause and container event bridge | Redis is a Compose service on host port 30117 | In-process typed event bus plus durable SQLite state for anything correctness-sensitive; no fake Redis protocol |
| Vault and integration secrets | `sulla_vault`, `DesktopVaultClient`, `VaultKeyService`, isolated Vault window, brokered tools | The service owns encrypted secret storage, human sessions, audit and broker capabilities; Desktop never decrypts values | Native vault broker in a dedicated utility process, sealed by OS keychain; opaque grants only |
| Files | `sulla_files`, `sulla_files_fuse`, `SullaFilesWatcher`, authenticated source gateway, Files bootstrap helper | Service owns encrypted chunks, Automerge history, permissions, audit, drafts, locks/retention; FUSE is mounted inside the VM for agents | Not in the first slice. Later, port the same Files authority to a native service; never expose host paths. Until then every Files surface says **Needs Full** |
| Workflows | `workflow_manager`, per-run containers, `WorkflowManagerClient`, Desktop scheduler/event bridge, PostgreSQL and Redis | Manager uses Docker socket and launches isolated runners; workflow state is PostgreSQL-backed | Lite runner in a dedicated native utility process for an allowlist of data-only/built-in nodes; durable execution leases/checkpoints in SQLite |
| Functions | On-demand `python_runtime`, `shell_runtime`, `node_runtime`; `function_run` materializes code into guest-owned volumes | Containers provide language/runtime and filesystem isolation | Disabled initially. Later use an OS sandboxed helper with no host mounts, default-deny network, explicit brokered capabilities; never run arbitrary code in Electron |
| Recipes | Extension service and Docker Compose | A recipe is explicitly a Compose stack | Full only. Marketplace card and installed-state APIs return `needsFull`, not success |
| Chat/primary agent loop | Chat completions server and graph live in Desktop, but tool execution, delegated agents and terminal paths assume VM/container services | Main orchestration is native; isolation and several tools are not | Run the primary graph in a dedicated Lite agent utility process with a Lite tool catalog; container/delegation tools are unavailable with structured `FULL_REQUIRED` errors |
| Delegated agents | `spawn_agent`, `AgentContainerLauncher`, agent images, threat-proxy network and Files bind | Each worker relies on container isolation, egress controls and scoped mounts | Full only in the first release. A future native agent sandbox must meet the same isolation and egress policy before enablement |
| Skills | PostgreSQL definitions, Files publication index, prompt assembly | Skill content is data, but the active catalog and Files authoring lifecycle are currently container-backed | Bundle built-ins and store Lite-installed skills in SQLite. Authoring/publishing that requires Files is Full until native Files ships |
| Signed integrations | Integration package store/grants in PostgreSQL, vault broker, proxy path allowlists | Catalog data is portable; secret custody currently uses container Vault | SQLite package/grant metadata plus native vault broker. Preserve signature, exact-version, declared-path and user-grant checks unchanged |
| Accounts | `sulla_accounts` container plus Desktop client | Local broker and its database are containerized | Cloud sign-in remains native; local server/account brokering is Full-only unless separately ported |
| Relay/mobile remote tools | relay container/tunnels and local tool tunnel | Some tunnels target container services | Out of first slice; show **Needs Full** for remote execution. Cloud authentication alone does not enable upload/sync |
| Threat proxy | VM network, fixed agent bridge and `sulla-threat-proxy` | It enforces container egress | Lite has no untrusted-code execution initially. Native HTTP tools continue using permissioned brokers; native sandbox work must add equivalent egress enforcement before functions/agents ship |
| Terminal, Kubernetes, Docker and server mode | VM terminal server, Docker client and guest services | These are VM features by definition | Full only |

### Service-lifecycle implication

The lifecycle manager can remain the orchestration mechanism, but registrations must be supplied by a runtime-profile adapter. Lite must not register placeholder `postgres`, `redis`, or `vault` services that report ready without providing their contracts. A prototype should introduce a read-only `RuntimeCapabilities` description first, then prove alternate providers for storage and vault behind existing service interfaces. This keeps Full behavior additive and unchanged.

## Lite substitutes and security impact

### 1. Storage: SQLite, not PGlite

Use `better-sqlite3`, which is already a packaged dependency, in a dedicated native data utility process. SQLite is smaller and operationally simpler than embedding a PostgreSQL-compatible WebAssembly engine, and it has mature backup and integrity primitives. PGlite reduces SQL-porting work but adds a WASM/Postgres compatibility layer whose Electron packaging, concurrency and migration behavior would still need proof.

Do not attempt a transparent SQL-string shim over the existing `pg` client. The current migrations and models use PostgreSQL types, operators, locking and transaction semantics. Define repository interfaces by domain, then port only the Lite slice. Store schema version, migration journal, application records and an append-only security audit in one application-private database; use WAL mode, foreign keys, restrictive file permissions and OS-backed encryption for sensitive metadata. Secrets themselves never enter this database.

Redis is not a source of truth in Lite. Replace pub/sub and ephemeral cache uses with a typed process-local bus. Replace pause, stop, lease, idempotency and schedule state with SQLite transactions so an application crash cannot convert a cache eviction into a permission or execution error.

**Security impact:** removing network-listening databases reduces exposed local services. Moving data onto the host makes OS account and disk protection part of the boundary, so the database must live in Electron `userData`, never a shared folder, and must not contain plaintext credentials. SQLite audit rows need integrity chaining or signed checkpoints before they can support stronger audit-evidence claims.

### 2. Vault: OS-sealed native broker

The native vault is a separate, hardened utility process with no agent RPC. Its master wrapping key is held by macOS Keychain/Windows Credential Manager/Linux Secret Service through an audited platform abstraction; Electron `safeStorage` may protect only bootstrap/capability material, not become a general plaintext-secret API. Secret values are encrypted at rest with per-record authenticated encryption and context binding.

The public contract remains brokered:

1. The human connects or edits a secret in the isolated Vault UI.
2. An integration requests a scoped grant for an exact integration, version, operation and declared remote path.
3. The broker validates the signed package, grant, destination and request shape.
4. The broker injects the secret and performs or tightly controls the outbound request.
5. The caller receives the response, never the credential.

No generic `decrypt`, `export`, environment-variable injection, IPC-return-secret or key-material method is allowed. Lock revokes live capabilities and clears process memory. Clipboard reveal and browser autofill remain human-session operations. Audit records must not contain secret values.

**Security impact:** VM/container isolation is replaced with OS process isolation. This is acceptable only if agent processes cannot address the vault control channel, IPC validates sender identity and capabilities, and the broker is independently testable. A same-process keychain wrapper would weaken the current boundary and is rejected.

### 3. Files: preserve the service boundary or disable it

Lite must not implement Files as a folder picker plus direct agent filesystem calls. The later native Files port runs as a separate local service and retains the existing authority: canonical virtual paths, collection membership, per-actor authorization, encrypted chunks, Automerge/version history, draft/publish rules, audit, record locks, retention, protected-name rejection and capability-scoped content reads. User-selected source folders are ingested through opaque handles held by the trusted service; agents see Files IDs and virtual paths only.

The first slice disables Files, attachments sourced from Files, file search, Use Case authoring through Files and tools that require `/mnt/sulla-files`. The UI explains that Full is required. It does not offer a raw host-path fallback.

**Security impact:** disabling the feature preserves the boundary. A premature native folder bridge would violate the NIST SP 800-171 direction by giving agents direct host access.

### 4. Workflows: native orchestrator, restricted nodes

Run Lite workflows in a dedicated utility process using the existing workflow schema and validation. A capability analyzer computes compatibility before install and before each run. The initial allowlist is control/data nodes, model prompts, skills, and signed integration calls supported by the native broker. Scheduling persists next-run, lease, attempt, pause/stop and checkpoint state in SQLite. Each node receives a short-lived execution capability containing only its declared permissions.

Unsupported nodes make the whole workflow `needsFull`; they are never skipped. Mixed workflows cannot partly execute and claim success. Extension Contract v1 manifests gain additive runtime requirements such as `requires: ["functions"]` or `runtimeProfiles: ["full"]`; old manifests retain Full compatibility and are evaluated conservatively for Lite.

**Security impact:** the reduced node set contains no arbitrary code or host filesystem access. Moving orchestration out of containers reduces crash isolation, so the utility process needs resource/time limits, cancellation and recovery tests. Functions and delegated agents remain disabled until a real OS sandbox exists.

### 5. Functions and agents: Full first, sandbox later

The first release returns `FULL_REQUIRED` from function execution, recipe tools, delegated-agent spawning and terminal/container tools. Their catalog entries remain visible with a **Needs Full** badge and a one-click upgrade explanation.

A later sandbox prototype must use platform primitives rather than a language-level promise: macOS App Sandbox or a constrained helper profile, Windows AppContainer, and Linux namespaces/seccomp/landlock where available. It starts with an empty temporary filesystem, no inherited environment, no home directory, no Files or vault path, default-deny network, CPU/memory/time/output quotas, and capability RPC for approved integration or Files operations. If a platform cannot supply this boundary, functions and delegated agents stay Full-only there.

**Security impact:** disabling is safer and more honest than executing marketplace code in Electron, `child_process`, a shell, or a worker thread. A worker thread is not a security boundary.

### 6. Recipes and integrations

Recipes remain Full-only because their contract is Docker Compose. Signed integrations are Lite-capable when they are declarative proxy packages and pass the same signature, immutable-package, declared-path and per-version grant checks as Full. An integration package that contains executable native code is Full-only until the sandbox phase.

**Security impact:** Lite must not broaden integration proxy paths or treat a marketplace signature as user authorization. Signature trust and user permission grants are separate gates.

## User experience and honest capability states

Onboarding offers:

- **Lite — quick setup:** chat, skills, supported workflows and integrations; no VM download.
- **Full — complete local runtime:** Files, functions, recipes, delegated agents, terminal and server tools.

Lite should reach its welcome screen immediately while native services initialize, then show a concrete readiness or error per capability. Every feature and marketplace item has one of four machine-readable states: `available`, `needsSetup`, `needsFull`, or `unavailable`. `needsFull` includes a reason code and a list of missing capabilities. Search results remain visible so Lite is useful for discovery.

Examples of honest UI copy:

- **Function — Needs Full:** “This function runs code in an isolated runtime. Upgrade to Full to install it.”
- **Workflow — Needs Full:** “This workflow uses 2 function nodes and a delegated agent.”
- **Files — Needs Full:** “Files keeps agents behind permission and audit controls provided by the Full runtime. Lite will not open your folders directly.”
- **Recipe — Needs Full:** “Recipes run Docker services.”

CLI and IPC callers receive a structured error, for example `{ code: "FULL_REQUIRED", capability: "functions", blockers: [...] }`. They must not receive a generic connection refusal or a false empty list.

## Upgrade from Lite to Full

Upgrade is a transactional export/import, not two runtimes pointing at one mutable store.

1. **Preflight:** verify disk space, Full runtime support, schema compatibility, VM images and a healthy destination. Keep Lite active if preflight fails.
2. **Quiesce:** pause new Lite workflow launches, finish or checkpoint active runs, lock the native vault broker and record a high-water mark.
3. **Snapshot:** create an atomic SQLite backup plus a signed manifest containing schema version, record counts and hashes. Export encrypted vault records as an authenticated envelope; never export plaintext or OS wrapping keys. Preserve the original snapshot read-only.
4. **Start Full in migration mode:** initialize empty Postgres/Vault/Files stores without switching the user profile.
5. **Import by stable IDs:** migrate settings, model-provider metadata, chats/messages, skills, workflow definitions/schedules/history/checkpoints, integration packages/grants, marketplace provenance and audit references. Translate timestamps and JSON explicitly; validate foreign keys and counts.
6. **Rewrap vault data:** after human authentication, transfer encrypted values over the authenticated bootstrap channel and rewrap under the Full vault master. Desktop handles status only. Reissue grants against the same integration IDs and versions.
7. **Compatibility check:** mark workflows/items requiring Full as available, but do not auto-run schedules that were paused during migration. Require an explicit resume choice for overdue schedules.
8. **Verify:** compare counts and content hashes, open representative records, test a synthetic broker request, and run database integrity checks.
9. **Commit:** atomically change `runtimeProfile` to Full and restart. Retain the Lite snapshot for a documented rollback window.
10. **Rollback:** stop Full, restore the untouched Lite snapshot/profile, and discard only the failed destination created by this migration. Never downgrade-write newer Full data into Lite.

The migration is idempotent by source snapshot ID and record ID. A retry must update or skip the same imported records, not duplicate them. Lite-to-Full is supported first; Full-to-Lite is not promised because Full may contain Files, functions, recipes and agent state that Lite cannot represent. Users may export portable chat and extension data separately, but the UI must call that an export, not a downgrade.

Cloud authentication remains separate from sync consent throughout. Choosing Lite, Full, or upgrade must not upload local data or enable Cloud sync.

## Delivery plan and effort

Estimates are engineering weeks for one experienced engineer, including focused policy/data tests and review but excluding external security assessment. Parallelism can shorten calendar time, not total effort. The uncertainty range is intentionally broad where current PostgreSQL models or container contracts are deep.

| Phase/piece | Deliverable | Estimate | Exit evidence |
|---|---|---:|---|
| 0. Capability spike | Runtime profile setting, capability registry, `FULL_REQUIRED` contract, dependency inventory; no behavior change in Full | 1–2 weeks | Full boot parity; UI/CLI render deterministic Needs Full states |
| 1. Native data foundation | SQLite utility process, domain repositories for settings/chat/skills/integration/workflow subset, migrations, backup/integrity tooling; event bus | 3–5 weeks | Crash/restart, migration, CRUD accuracy and concurrency tests; no listeners exposed |
| 2. Native vault broker | OS keychain abstraction, encrypted store, isolated UI/session, scoped integration proxy, audit and lock/revoke | 4–6 weeks plus security review | Agent/renderer denial tests, sender authentication, no-secret logs, restart/recovery and grant tests |
| 3. Internal Lite preview | Installer/onboarding choice; model setup; chat with built-in/local skills; signed declarative integrations; no Files/functions/recipes/delegated agents | 3–5 weeks after phases 0–2 | Fresh-machine install to first chat; unsupported tools return structured Needs Full; Full regression CI |
| 4. **First shippable Lite slice** | Native workflow utility runner, compatibility analyzer, scheduling, leases/checkpoints and supported node allowlist, added to the phase 3 preview | 4–6 weeks | Chat, skills, supported workflows and integrations work on a clean machine; resume/idempotency/pause/stop tests pass; an unsupported node prevents the entire run |
| 5. Lite-to-Full migration | Snapshot/import/rewrap/verify/commit/rollback coordinator | 3–5 weeks | Fault injection at every stage; counts/hashes and vault rewrap verified; old Lite snapshot remains usable |
| 6. Native Files service | Port service authority/storage plus native virtual filesystem/API client; no direct host paths | 8–12 weeks plus security review | Permission/identity, envelope, version, audit, lock/retention, protected-path and recovery suites |
| 7. Sandboxed functions | Platform helpers and broker capabilities, initially Node only; Python/shell only where equivalent isolation exists | 6–10 weeks per supported platform family | Escape, network, filesystem, resource, secret and capability-boundary tests |
| 8. Native delegated agents | Sandboxed workers, scoped Files API, egress controls, lifecycle and cleanup | 6–10 weeks after phases 6–7 | Isolation/egress parity evidence; no host mount or vault channel reachability |

The smallest credible release is phases 0–4: roughly 15–24 engineering weeks plus security review. That is the first slice that delivers the promised set of chat, skills, workflows and integrations. Phase 3 can support internal testing, but shipping it as “Lite” would omit workflows. A thinner chat-only demo without the native vault boundary would also either omit integrations/model credentials or weaken secret custody.

## Prototype plan

The prototype is a sequence of killable proofs, not a branch-wide refactor.

1. **Capability seam:** add a `RuntimeCapabilities` object and make one noncritical Full-only surface (recipes) render and return `FULL_REQUIRED` under a developer-only Lite flag. Full remains the default.
2. **Storage proof:** implement repositories for one chat thread, one skill and one declarative integration in SQLite. Measure cold start, transaction recovery and packaged-app migration. Do not port every model.
3. **Vault proof:** build a native broker that stores a synthetic credential, authorizes one fixed integration request, injects it, and proves an agent/renderer cannot read it. Commission a focused threat review before broadening operations.
4. **Chat proof:** run a primary chat in a utility process with a generated Lite tool catalog. Verify that disallowed tool calls fail with `FULL_REQUIRED`, not host execution.
5. **Workflow proof:** execute a three-node data/prompt/integration workflow, persist a checkpoint, kill the utility process, and resume exactly once. Reject the same workflow when a function node is added.
6. **Migration proof:** import synthetic Lite data into disposable Full services, rewrap a synthetic vault record, compare hashes/counts, then inject a failure and restore Lite.

Each proof lands behind a developer flag and can be deleted independently. Production implementation starts only after the proof's boundary tests pass. No prototype may read live vault data or real user files.

## Acceptance gates

Lite is releasable only when all of these are true:

- A clean supported machine installs and reaches a model-backed chat without installing or booting a VM/container engine.
- Full remains the default for existing users and its add-ons work unchanged.
- An agent, renderer, skill, workflow and integration package cannot obtain vault plaintext or key material.
- No Lite agent or extension can receive a host path or directly open a user-selected host file.
- Unsupported features are discoverable but consistently return **Needs Full** before mutation or execution.
- Lite workflow compatibility is checked at install and again at run time; unsupported nodes cause no partial run.
- Crash recovery does not duplicate scheduled work, integration grants or migration records.
- Lite-to-Full migration is resumable and rollback leaves the original Lite snapshot intact.
- Logs, crash reports and migration manifests contain no secrets or decrypted file contents.
- Documentation makes no NIST SP 800-171 compliance claim and records which controls have actual evidence.

## Open decisions before implementation

These do not block the architecture spike, but they must be decided before production packaging:

1. Supported Lite platforms for the first release. The OS keychain and later sandbox implementations differ materially.
2. Whether a local model is in Lite's first product promise. Bundling model inference changes installer size and resource expectations; cloud/API models do not.
3. The retention window and user-visible deletion flow for the rollback snapshot after a successful Full migration.
4. Whether native Files is a Lite roadmap item or a permanent Full differentiator. Either answer must preserve the service boundary.

## Code references audited

- `pkg/sulla-desktop/backend/sullaRuntimeBackend.ts` — VM boot, Docker readiness, generated Compose, managed-service reconciliation and Desktop startup handoff.
- `pkg/sulla-desktop/backend/sullaRuntime/NativeRuntime.ts` and `pkg/sulla-desktop/runtime/containerRuntime.ts` — native VM process and container runtime surfaces.
- `pkg/sulla-desktop/assets/sulla-docker-compose.yaml` — Postgres, Redis and on-demand function runtimes.
- `pkg/sulla-desktop/sulla.ts` and `pkg/sulla-desktop/agent/services/ServiceLifecycleManager.ts` — Desktop lifecycle graph, dependency and vault gates.
- `pkg/sulla-desktop/agent/database/{DatabaseManager,PostgresClient,RedisClient}.ts` — persistence, migrations and coordination clients.
- `pkg/sulla-desktop/agent/services/{DesktopVaultClient,VaultKeyService}.ts` and `services/sulla-vault/` — container-owned secret boundary.
- `pkg/sulla-desktop/main/sullaFilesWatcher.ts`, `pkg/sulla-desktop/main/sullaFilesSourceGateway.ts`, `services/sulla-files/` and `services/sulla-files-fuse/` — Files authority and virtual filesystem boundary.
- `services/sulla-workflows/`, `pkg/sulla-desktop/agent/services/WorkflowManagerClient.ts` and workflow tools — manager, runners, schedules and execution state.
- `pkg/sulla-desktop/agent/tools/function/` and `pkg/sulla-desktop/backend/onDemandServices.ts` — function materialization and runtime containers.
- `pkg/sulla-desktop/agent/services/AgentContainerLauncher.ts` and agent spawn tools — delegated container agents and isolation assumptions.
- `resources/sulla-docs/{extensions.md,marketplace/overview.md,tools/marketplace.md,environment/files-harness.md,environment/files.md}` — extension compatibility, install paths and Files security/lifecycle contracts.
