# Routines — Schema & Design

**Status:** Draft
**Date:** 2026-04-21
<<<<<<< HEAD
**Scope:** Defines what a **Routine** is in Sulla Desktop, how it is stored, and how it relates to **Functions** and the **runtime containers** that execute code.

> Routines are **one of four peer kinds** in the bundle model — routines, skills, functions, recipes. Each has its own on-disk folder layout and runtime concerns, but they share the same import/export/publish/install flow. See [`../../bundles/README.md`](../../bundles/README.md) for the cross-kind contract.

> **Heads-up:** "Routine" is the new name for what used to be called a **workflow** inside Sulla Desktop. The old `workflow` terminology is being retired. If a doc, database column, IPC name, or type still says `workflow`.
=======
**Scope:** Defines the on-disk format, validation schema, and governance rules for **Routines** — the unit of reusable executable work that workflows compose and the Sulla runtime executes.
>>>>>>> 8d17f29361b8c7cf734279fd7709c9c9b4a68317

---

## 1. What is a Routine?

A **Routine** is a self-contained unit of work that a workflow node can invoke. Think of it as a versioned, schema-validated "skill" with a deterministic execution contract:

- **ROUTINE.md** — LLM/human-facing documentation. Describes what the routine does and when to use it.
- **routine.yaml** — Engine-facing manifest. Declares runtime, inputs, outputs, permissions, and execution spec.
- **functions/** — The actual code (Python, Node, shell, or an agent-prompt). Hot-reloaded by the runtime container.
- **resources/** — Static read-only data (API schemas, reference docs, modular knowledge).
- **templates/** — Parameterized output templates (Jinja2, Handlebars).

<<<<<<< HEAD
In concrete terms:

- **Canvas model:** nodes (typed, per-node config) + edges + viewport + top-level metadata.
- **Runtime storage:** rows in the Postgres `workflows` table. The graph lives in the `definition` JSONB column. (The table is called `workflows` for historical reasons — it stores routines.) This is the source of truth for the DAG walker.
- **Authorship bundle:** a folder at `~/sulla/routines/<slug>/` containing `routine.yaml` plus supporting files (`AGENT.md`, `skills/`, `prompts/`, `references/`, `assets/`, `examples/`, …). Folders in this directory show up in the **My Templates** tab. See [folder-layout.md](./folder-layout.md) for the full layout.
- **Distribution format:** a `.routine.zip` containing the bundle. Produced by export, consumed by import.
- **Execution:** the DAG walker reads from Postgres and dispatches each node to the appropriate handler (agent, integration call, function runtime, etc.).

### Templates vs. routines

| | Templates | Routines |
|---|---|---|
| Where | `~/sulla/routines/<slug>/` (folders on disk) | Postgres `workflows` table |
| Tab | **My Templates** | **My Routines** |
| Role | Reference library / starting point | Your editable, runnable instance |
| Created by | Import, or hand-authored on disk | Instantiating a template, or creating blank |
| Edited by | Finder / git / text editor | The Sulla canvas |
| Execution | Not directly — must be instantiated first | Yes, by the DAG walker |

A routine carries an optional `source_template_slug` column pointing back to the template it was instantiated from. Export uses this to re-bundle sibling files (AGENT.md, skills/, etc.) alongside the current DB definition.

Routines are **installation-scoped**. There is no global registry, no semver, no publish step, no trust tier, no signature. Distribution is by hand — you zip, you share, someone imports.

---

## 2. Routine = Workflow (DAG)

The shape of a routine is identical to the existing `WorkflowDefinition` TypeScript interface in `pkg/rancher-desktop/pages/editor/workflow/types.ts`:

```ts
interface WorkflowDefinition {
  id:          string;
  name:        string;
  description: string;
  version:     1;
  createdAt:   string;
  updatedAt:   string;
  nodes:       WorkflowNodeSerialized[];
  edges:       WorkflowEdgeSerialized[];
  viewport?:   { x: number; y: number; zoom: number };
}
```

See [routine.schema.json](./routine.schema.json) for the formal schema (it mirrors this shape exactly).

Every node has a `subtype` drawn from `WorkflowNodeSubtype` — including the new `subtype: 'function'` that invokes a function (see section 3).

---

## 3. How a routine invokes code: the function node

The canvas has a **Function** node (`subtype: 'function'`, category `agent`). Its config is `FunctionNodeConfig`:

```ts
interface FunctionNodeConfig {
  functionRef:     string;  // slug of a function at ~/sulla/functions/<slug>/
  inputs:          Record<string, string>;                                       // template-aware
  vaultAccounts:   Record<string, { accountId: string; secretPath: string }>;    // per-node secret binding
  timeoutOverride: string | null;
}
```

When the playbook walker reaches a function node:

1. It reads `~/sulla/functions/<functionRef>/function.yaml` to learn the function's runtime (python/node/shell), declared inputs/outputs, and env/secret requirements.
2. It resolves `inputs` via the normal `{{variable}}` template substitution.
3. It resolves `vaultAccounts` to actual secret values from the Sulla vault.
4. It HTTP-POSTs `/invoke` on the matching runtime:
   - `python-runtime` → `http://127.0.0.1:30118/invoke`
   - `shell-runtime`  → `http://127.0.0.1:30119/invoke`
   - `node-runtime`   → `http://127.0.0.1:30120/invoke`
5. The runtime loads `/var/functions/<slug>/` (bind-mounted from `~/sulla/functions/`) and executes the declared entrypoint.
6. The response is attached to the node's output and becomes addressable downstream as `{{ <node-id>.output.<field> }}`.

Runtimes execute **functions**, never routines. Routines are orchestrated by the in-process DAG walker.

---

## 4. Storage: DB vs. disk

Two separate stores, linked by `source_template_slug`:

```
Postgres `workflows` table                ~/sulla/routines/<slug>/
─────────────────────────────             ────────────────────────
id, name, description, version            routine.yaml       ← DAG (same schema as the JSONB)
status, enabled                           AGENT.md           ← orchestrator instructions
definition (JSONB) ◄───── canvas          README.md          ← human-facing doc
source_template_slug ────────────────►    skills/, prompts/, references/, assets/, examples/, functions/
created_at, updated_at                    .routine-meta.yaml ← exporter-managed metadata
```

**The canvas writes only to Postgres.** Folders on disk are never auto-updated by the app. They are touched only by explicit user actions: Import (unpacks into a new folder) and the template being hand-authored in a text editor.
=======
Routines are what agents author when a workflow needs a step that doesn't exist yet. They map 1:1 onto the runtime-container-per-language execution model (see `PRD_WORKFLOW_SYSTEM.md`).

---

## 2. Directory Layout
>>>>>>> 8d17f29361b8c7cf734279fd7709c9c9b4a68317

```
routines/<routine-name>/
├── ROUTINE.md              # LLM-facing spec (markdown with minimal frontmatter)
├── routine.yaml            # Engine manifest (validated against routine.schema.json)
├── functions/              # Hot-reloadable code
│   └── main.py             # Entrypoint (referenced in routine.yaml)
├── resources/              # Static read-only data (loaded on demand)
│   └── invoice-schema.json
├── templates/              # Parameterized outputs
│   └── receipt.j2
└── .routine/               # Sulla-managed metadata (auto-generated, git-tracked)
    ├── version.json        # Semver + changelog
    ├── lock.json           # Schema version + runtime pin
    └── signature.sha       # Content hash for integrity
```

<<<<<<< HEAD
**Import** unpacks a `.routine.zip` (or a folder the user picks) into `~/sulla/routines/<slug>/`. Slug collisions get suffixed (`-2`, `-3`, …). The DB is not touched — the new template appears in **My Templates** on next scan. Getting it into the DB is a second user action (clicking "Use template" / instantiate).

**Export** pulls from the DB (the source of truth for the DAG). If the routine has a `source_template_slug` pointing to a still-present template folder, the exporter copies that folder into a temp dir, overwrites `routine.yaml` with the current DB definition (stripped of runtime state), updates `.routine-meta.yaml`, zips it, and writes to a user-picked location. If no source template exists, the bundle contains only the seeded minimum. **Export never writes back to `~/sulla/routines/`** — shared artifacts go wherever the user chooses.

Exporting a template (from **My Templates**) is a simpler path: just zip the existing folder as-is. The DB is not involved.

See [folder-layout.md](./folder-layout.md) for the full per-file spec and [routine.schema.json](./routine.schema.json) for the formal schema of `routine.yaml`.
=======
Routines live under `~/sulla/routines/` with the same lifecycle model as workflows:

```
~/sulla/routines/
├── draft/        — In-development (mutable)
├── production/   — Active, referenced by workflows
└── archive/      — Deprecated
```
>>>>>>> 8d17f29361b8c7cf734279fd7709c9c9b4a68317

---

## 3. The Two-File Split

<<<<<<< HEAD
| File                        | Purpose                                                                 |
|-----------------------------|-------------------------------------------------------------------------|
| `README.md`                 | This document.                                                          |
| `folder-layout.md`          | Per-file spec for the `~/sulla/routines/<slug>/` template folder.       |
| `routine.schema.json`       | JSON Schema for the `routine.yaml` document (canvas JSONB + YAML export). |
| `examples/minimal-routine/` | A tiny example template folder — heartbeat → function → response.       |
=======
The decision to split metadata across `ROUTINE.md` and `routine.yaml` is deliberate:

| File           | Audience    | Purpose                                                                 |
|----------------|-------------|-------------------------------------------------------------------------|
| `ROUTINE.md`   | LLM / human | "What is this and when do I use it?" — free-form markdown instructions. |
| `routine.yaml` | Engine      | "How do I execute it?" — typed schema: inputs, outputs, runtime, perms. |

`ROUTINE.md` frontmatter is intentionally thin — only a back-pointer to the routine name + version. All structured metadata lives in `routine.yaml` as the single source of truth, preventing drift between the two files.
>>>>>>> 8d17f29361b8c7cf734279fd7709c9c9b4a68317

---

## 4. Workflow Compatibility

<<<<<<< HEAD
- **Workflow→routine rename rollout.** The code still uses `workflow`/`Workflow` in types, tables, IPC names, and file paths. The docs are leading; the code renames happen in follow-up patches. Tracked in [../../MIGRATION_NOTES.md](../../MIGRATION_NOTES.md).
- **Bundle schema versioning.** `.routine-meta.yaml` carries a `bundleSchemaVersion` so the importer can refuse or migrate future layouts. `routine.yaml` itself still uses `version: 1` for the DAG-document shape — the two are independent.
- **Cross-machine routine sync.** Export/import handles one-shot sharing. Continuous sync (git-backed templates, remote registries) is out of scope.
- **AGENT.md spec.** The frontmatter fields (`name`, `summary`, `triggers`, `required_integrations`, `required_vault_accounts`, `required_functions`, `entry_node`) are described in `folder-layout.md` but don't yet have their own JSON Schema. Add one if the field set stabilizes.
=======
`routine.yaml` uses the same top-level metadata conventions as `workflow.yaml`:

| Field         | Workflow | Routine | Notes                              |
|---------------|----------|---------|------------------------------------|
| `id`          | ✓        | ✓       | Prefix: `workflow-` or `routine-`  |
| `name`        | ✓        | ✓       | Human-readable                     |
| `description` | ✓        | ✓       | What + when                        |
| `version`     | ✓        | ✓       | Semver                             |
| `enabled`     | ✓        | ✓       | Active/inactive                    |
| `createdAt`   | ✓        | ✓       | ISO timestamp                      |
| `updatedAt`   | ✓        | ✓       | ISO timestamp                      |
| `_status`     | ✓        | ✓       | `draft` / `production` / `archive` |
| `nodes`       | ✓        | —       | Workflow-only (graph)              |
| `edges`       | ✓        | —       | Workflow-only (graph)              |
| `spec`        | —        | ✓       | Routine-only (execution)           |

The engine disambiguates via the `kind` field (`Workflow` vs `Routine`) at the top of each file.

Workflows reference routines via a new node subtype (see [workflow-integration.md](./workflow-integration.md)):

```yaml
- id: node-abc
  type: workflow
  data:
    subtype: routine                                # NEW subtype, "Agents" category
    category: agent
    label: "Fetch Stripe Invoice"
    config:
      routineRef: fetch-stripe-invoice@1.2.3       # name@version
      inputs:
        invoice_id: "{{ trigger.invoice_id }}"
```

---

## 5. Governance — "Do we allow changes to routines?"

**Yes — but versions are immutable once published.** Three rules govern mutation:

### Rule 1. Unpublished routines are mutable.

While `_status: draft` and no tagged version exists, anyone (human or agent) may edit the routine freely. No restrictions. This is the fast-iteration phase.

### Rule 2. Published versions are immutable.

Once `sulla routine publish <name> <version>` runs, that exact content is frozen forever. The routine's `.routine/signature.sha` is sealed; the runtime loader refuses to execute a published routine whose content hash doesn't match its signature.

To change a published routine, you cut a new version:

- **Patch (1.2.3 → 1.2.4)** — bug fix, no behavior change for existing callers.
- **Minor (1.2.3 → 1.3.0)** — backward-compatible additions (new optional input, new output field).
- **Major (1.2.3 → 2.0.0)** — breaking change (removed input, changed output shape).

Workflows pin to a version (`routineRef: fetch-stripe-invoice@1.2.3`) or a semver range (`fetch-stripe-invoice@^1` for auto-minor-updates). Same mental model as npm or Docker images.

### Rule 3. `locked: true` routines require human approval for ANY change.

For critical-path routines (billing, auth, irreversible actions), setting `locked: true` in `routine.yaml` means:

- Agents cannot modify the routine via `sulla routine edit` without a human co-signer.
- Even in draft state, edits require an explicit `--unlock` flag plus a review record.
- The signature check is strict: any tampering breaks the signature and the routine is quarantined.

Locked routines are the fence around things that must not be "improved" autonomously.

### What this means in practice

- Agents iterating on a new routine? Full write access. No friction.
- Agent wants to "fix" a published routine? Blocked — must cut a new version.
- Workflow wants the new behavior? Update its `routineRef`, which is a reviewable change.
- Someone tampered with a locked routine's files? Signature mismatch → runtime refuses to load → alert raised.

This is the npm/Docker model. Mutation is not forbidden — mutation of published artifacts is.

---

## 6. Schema Protection

The schema is the contract. Four enforcement points, no hard size limits:

1. **JSON Schema.** `routine.schema.json` is the authoritative contract for `routine.yaml`. `frontmatter.schema.json` covers `ROUTINE.md` frontmatter. Both are versioned (`schemaversion` field).

2. **Runtime loader validation.** The runtime container validates every routine at load time against its pinned schema version. Invalid routines never reach the workflow engine — the error surfaces in the workflow UI.

3. **CLI-gated authoring.** `sulla routine scaffold`, `sulla routine edit`, `sulla routine publish` all validate before writing. A git pre-commit hook runs `sulla routine validate` to catch invalid routines before they reach the repo.

4. **Signed content.** `.routine/signature.sha` = hash of `ROUTINE.md` + `routine.yaml` + `functions/`. Tampering breaks the signature; the runtime refuses to execute.

**No hard limits on size, line count, or file count.** The schema defines *shape*, not *scale*. Bloat is a lint concern (separate tool, advisory only), not a validation failure.

---

## 7. Version Control Strategy

**Monorepo for development, published-per-routine repos for distribution.**

- **Dev:** all routines live in `~/sulla/routines/` as a monorepo. Easy cross-routine refactor, single PR, shared tooling.
- **Publish:** `sulla routine publish <name>` extracts the routine's subtree, pushes it to a dedicated git repo `sulla-routines/<name>`, tags it with the version, signs it, uploads to the registry.
- **Consume:** workflows reference routines by `name@version`. The runtime fetches from the registry, caches locally, verifies the signature.

This matches the Helm chart / Docker image / npm package model. Dev ergonomics win the monorepo; distribution independence wins per-routine repos.

---

## 8. Files in this directory

| File                             | Purpose                                              |
|----------------------------------|------------------------------------------------------|
| `README.md`                      | This document.                                       |
| `routine.schema.json`            | JSON Schema for `routine.yaml`.                      |
| `frontmatter.schema.json`        | JSON Schema for `ROUTINE.md` frontmatter.            |
| `workflow-integration.md`        | How workflows reference and invoke routines.         |
| `runtime-containers.md`          | What the Docker runtime containers are and do.       |
| `workflow-storage.md`            | Postgres-backed workflow storage + incremental cutover plan. |
| `examples/fetch-stripe-invoice/` | Reference implementation of a full routine.         |

---

## 9. Open Questions

- **Registry implementation:** Use OCI (push routines as container images) or dedicated git repos? OCI gives us free signing, caching, and CDN; git repos give us diff-friendly source. Leaning OCI with source-of-truth in git.
- **Input/output schema spec:** JSON Schema draft 2020-12 is the obvious pick. Confirm.
- **Agent-authored routines:** should they default to `_status: draft` + `trust: user` with a mandatory human review before `production` promotion? Proposed yes.
- **Cross-routine calls:** can a routine invoke another routine directly (not via workflow)? Proposed no — routines are leaves; composition happens in workflows.
>>>>>>> 8d17f29361b8c7cf734279fd7709c9c9b4a68317
