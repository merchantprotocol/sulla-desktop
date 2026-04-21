# Routines — Schema & Design

**Status:** Draft
**Date:** 2026-04-21
**Scope:** Defines the on-disk format, validation schema, and governance rules for **Routines** — the unit of reusable executable work that workflows compose and the Sulla runtime executes.

---

## 1. What is a Routine?

A **Routine** is a self-contained unit of work that a workflow node can invoke. Think of it as a versioned, schema-validated "skill" with a deterministic execution contract:

- **ROUTINE.md** — LLM/human-facing documentation. Describes what the routine does and when to use it.
- **routine.yaml** — Engine-facing manifest. Declares runtime, inputs, outputs, permissions, and execution spec.
- **functions/** — The actual code (Python, Node, shell, or an agent-prompt). Hot-reloaded by the runtime container.
- **resources/** — Static read-only data (API schemas, reference docs, modular knowledge).
- **templates/** — Parameterized output templates (Jinja2, Handlebars).

Routines are what agents author when a workflow needs a step that doesn't exist yet. They map 1:1 onto the runtime-container-per-language execution model (see `PRD_WORKFLOW_SYSTEM.md`).

---

## 2. Directory Layout

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

Routines live under `~/sulla/routines/` with the same lifecycle model as workflows:

```
~/sulla/routines/
├── draft/        — In-development (mutable)
├── production/   — Active, referenced by workflows
└── archive/      — Deprecated
```

---

## 3. The Two-File Split

The decision to split metadata across `ROUTINE.md` and `routine.yaml` is deliberate:

| File           | Audience    | Purpose                                                                 |
|----------------|-------------|-------------------------------------------------------------------------|
| `ROUTINE.md`   | LLM / human | "What is this and when do I use it?" — free-form markdown instructions. |
| `routine.yaml` | Engine      | "How do I execute it?" — typed schema: inputs, outputs, runtime, perms. |

`ROUTINE.md` frontmatter is intentionally thin — only a back-pointer to the routine name + version. All structured metadata lives in `routine.yaml` as the single source of truth, preventing drift between the two files.

---

## 4. Workflow Compatibility

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
