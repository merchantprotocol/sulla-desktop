# Dynamic CRM — Architecture, Use Cases & User Stories

> Status: foundational. Backs the dynamic-CRM engine shipped in migrations
> `0029–0036` (PR #453). Authoritative companion to the source under
> `pkg/rancher-desktop/agent/services/CrmSchemaService.ts` and the AI tool
> surface in `pkg/rancher-desktop/agent/tools/crm/`.

This document promotes the local planning notes
(`projects/sulla-crm-dynamic-architecture/*`, gitignored scratch) into a
committed, reviewable reference. It is grounded in the code as shipped, not in
the original design assumptions.

---

## 1. Vision

Sulla's dynamic CRM lets the **AI reshape the CRM at runtime** — inventing new
record types, fields, relationships, views, dashboards and menu items — without
a developer, a migration, or a redeploy. The agent never emits DDL or raw SQL.
Instead it calls a small, validated, tenant-scoped Schema API; a generic,
metadata-driven UI then renders whatever now exists.

The mental model is deliberately inverted from a hand-coded CRM:

| Conventional CRM            | Sulla dynamic CRM                          |
| --------------------------- | ------------------------------------------ |
| "New table" = a migration   | "New table" = a `crm_record_types` row     |
| "New column" = a migration  | "New column" = a `crm_fields` row          |
| UI hand-built per entity    | One generic UI renders any type            |
| Schema owned by engineers   | Schema authored by the agent on demand     |

**Scope boundary.** This engine governs **net-new** custom record types
(Property, Vehicle, Permit, Inspection, …). The product's existing
Contact + Opportunities / Appointments / Jobs pipelines are a **separate**
system and are intentionally out of scope here.

---

## 2. Architectural principles

1. **Schema-as-data, not DDL.** Types and fields are rows, not tables and
   columns. The agent's "schema" calls mutate metadata only. This is the
   keystone of the whole design.
2. **Guarded Schema API is the only writer.** All mutation flows through
   `CrmSchemaService`. There is no agent path that runs arbitrary SQL against
   CRM tables. The service validates slugs, enforces `is_system` protection,
   and demands an explicit `confirm` flag on destructive ops.
3. **Two op families, two risk profiles.**
   - *Schema ops* (types/fields/relationships/views/dashboards/widgets/menu) —
     low frequency, high blast radius → stronger guards.
   - *Data ops* (create/update/link records) — high frequency, lightweight →
     value coercion and tenant scoping, but lighter guards.
4. **Everything is tenant-scoped.** A `tenant_id` partitions all rows.
   `DEFAULT_TENANT_ID = 'default'` on the single-user desktop; it maps to a
   Sulla workspace under Cloud, so the same schema works multi-tenant unchanged.
5. **Everything is reversible.** Mutations are soft-deletes (archive), and each
   successful mutation returns an `undoToken`. `crm/undo` reverts
   create/update/archive/link ops generically and idempotently.
6. **Generic UI over a metadata contract.** The renderer reads record types,
   fields and views; it never hard-codes any specific type.

---

## 3. Data model

A handful of metadata tables describe the schema; records use a hybrid
core-columns + EAV (entity–attribute–value) layout for their field values.

### 3.1 Schema (definition) tables

| Table                | Holds                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| `crm_record_types`   | A "table": `key`, `label`, `label_plural`, `icon`, `color`, `is_system` |
| `crm_fields`         | A "column": `record_type_id`, `key`, `label`, `data_type`, `config`, `is_required`, `is_unique`, `is_title`, `is_system` |
| `crm_relationships`  | Typed edges: `from_type_id`, `to_type_id`, `cardinality`, `from_label`, `to_label`, `key` |
| `crm_views`          | Saved views: `record_type_id`, `name`, `kind`, `config`               |
| `crm_dashboards`     | Widget containers: `key`, `name`, `icon`, `layout`                    |
| `crm_widgets`        | A chart/stat on a dashboard: `dashboard_id`, `record_type_id`, `kind`, `config` |
| `crm_menu_items`     | Navigation entries: `label`, `icon`, `target_type`, `target_id`, `auto_created` |

### 3.2 Record (data) tables

- **`crm_records`** — one row per record. Static **core columns**:
  `id`, `title`, `created_at`, `updated_at` (plus `tenant_id`,
  `record_type_id`). `title` is denormalized from whichever field is marked
  `is_title` for fast listing/sorting.
- **Record values (EAV)** — one row per (record, field). Each value lands in the
  **typed column** matching its field's `data_type`:

  | `data_type`                                   | Stored in        |
  | --------------------------------------------- | ---------------- |
  | `text`, `long_text`, `email`, `phone`, `url`, `select` | `value_text`     |
  | `number`, `currency`                          | `value_number`   |
  | `bool`                                         | `value_bool`     |
  | `date`, `datetime`                            | `value_datetime` |
  | `multi_select`, `json`                        | `value_json`     |
  | `relation`                                    | *(none — see below)* |
  | `computed`                                    | *(none — derived at read time)* |

- **`crm_record_links`** — `relationship_id`, `from_record_id`,
  `to_record_id`. **`relation` fields are not stored as values** — they are
  links in this table, so the same edge powers both directions and
  many-to-many.
- **`computed` fields** are formula fields **derived at read time**, never
  persisted.

### 3.3 Audit & undo

`CrmSchemaService` writes an audit entry per mutation (`recordAudit`) carrying
the `entity_type → backing table` mapping so `undo()` can revert generically.
Migration `0036` adds the dedicated audit/undo table. (Historical note: the
original design assumed a generic `audit_history` table from `0027`; that table
never existed — `0027` created only applescript/notification/function-run
tables — so audit/undo got its own migration.)

---

## 4. Field type system

Fifteen data types span the common CRM needs:

```
text  long_text  number  currency  date  datetime  bool
select  multi_select  relation  email  phone  url  json  computed
```

- `select` / `multi_select` carry their options in `config`.
- `relation` is realized via `crm_relationships` + `crm_record_links`, not a
  scalar value.
- `computed` is evaluated on read.
- `is_title` nominates the field whose value denormalizes into
  `crm_records.title`.
- `is_unique` / `is_required` are field-level constraints enforced by the
  service (not DB constraints, since the column is shared EAV storage).

---

## 5. Relationships

Defined with `crm/define_relationship` (`from_type`, `to_type`, `cardinality`
∈ `one_to_one | one_to_many | many_to_many`, optional human labels). The call
returns a `relationship_id`. Records are then connected with
`crm/link_records` / `crm/unlink_records`. Because links live in their own
table, traversal is symmetric and many-to-many is free.

---

## 6. Query engine

`crm/query_records` compiles a safe filter/sort over the hybrid layout:

- **Filter** keys are field keys *or* core columns (`id`, `title`,
  `created_at`, `updated_at`). A scalar means equality; an object expresses
  operators: `eq ne in notIn gt gte lt lte contains isSet`.
- The compiler routes each field condition to its `value_*` column and joins
  the EAV rows; core columns hit `crm_records` directly.
- **Sort** is `[{ field, dir: "asc" | "desc" }]`.
- `limit` defaults to 100, capped at 500.

Example — open, high-value deals, newest first:

```json
{
  "record_type": "deal",
  "filter": { "stage": { "notIn": ["Won", "Lost"] }, "value": { "gt": 5000 } },
  "sort":   [{ "field": "created_at", "dir": "desc" }],
  "limit":  50
}
```

---

## 7. Presentation layer

The agent composes the UI, it doesn't code it:

- **Views** (`crm/create_view`) — `table | kanban | calendar | list | gallery`,
  with `config` (groupBy, visible fields, …) per record type.
- **Dashboards** (`crm/create_dashboard`) — named widget containers.
- **Widgets** (`crm/create_widget`) — `stat | line | bar | funnel | list |
  table`, each driven by a record type and a metric/grouping `config`.
- **Menu items** — navigation surface; can be `auto_created` when a type is
  born so it's immediately reachable.

---

## 8. AI agent tool surface

The agent operates the engine through `sulla crm/<tool>` (manifests in
`pkg/rancher-desktop/agent/tools/crm/manifests.ts`):

| Group        | Tools                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| Schema       | `list_record_types`, `create_record_type`, `add_field`, `define_relationship`, `archive_record_type` |
| Data         | `create_record`, `update_record`, `archive_record`, `query_records`, `link_records`, `unlink_records`, `undo` |
| Presentation | `create_view`, `create_dashboard`, `create_widget`                                |

**Discovery contract:** call `list_record_types` first to learn what exists
before adding fields, creating records, or querying.

---

## 9. Use cases

Each is a net-new vertical the product CRM doesn't cover; the agent stands it up
end to end with no code change.

1. **Property management.** `Property`, `Unit`, `Tenant`, `Lease`,
   `MaintenanceTicket` types; relationships Property→Unit (1:N), Unit→Lease
   (1:N), Lease→Tenant (N:N); a kanban of tickets by status; a dashboard with a
   stat (occupancy %) and a bar (rent roll by property).
2. **Fleet / vehicle tracking.** `Vehicle`, `Driver`, `ServiceRecord`; a
   calendar view of upcoming service `datetime`s; a funnel widget of vehicles
   by lifecycle stage.
3. **Permitting / inspections.** `Permit`, `Inspection`, `Violation`; computed
   "days until expiry"; a table view filtered to `status isSet` and expiring
   soon.
4. **Event / catering ops.** `Event`, `Vendor`, `Booking`; N:N Event↔Vendor;
   gallery view of events; stat widget of confirmed bookings this month.
5. **Lightweight project tracker.** `Project`, `Task`, `Milestone`; kanban by
   task `select` status; line widget of completed tasks over time.

Any of these is reachable from a single natural-language request because every
primitive — type, field, relationship, view, widget — is an API call.

---

## 10. User stories

**As the AI agent (Heartbeat / Sulla):**

- …I can call `list_record_types` to learn the current schema before I change
  anything, so I never collide with existing structure.
- …I can create a record type with seed fields in one call, so standing up a new
  vertical is a single step.
- …when I run a destructive op I must pass `confirm: true` and I cannot touch
  `is_system` types, so I can't silently delete user structure.
- …every mutation hands me an `undoToken`, so I can offer the user a clean
  revert and recover from my own mistakes.

**As the end user:**

- …I can ask "track my rental properties" and get a working Property CRM —
  types, fields, a kanban, and a dashboard — without configuring anything.
- …I can trust that my hand-built types are protected from the agent
  (`is_system`, confirm-gated archive, soft-delete only).
- …I see my new section in the navigation immediately because a menu item is
  auto-created with the type.
- …I can undo the agent's last change from an audit trail.

**As the developer:**

- …I add a new field *data type* once, and every record type can use it — no
  per-type UI work.
- …the renderer reads metadata, so I never hand-build a screen for a specific
  customer's custom type.
- …all CRM mutation goes through one guarded service, so the audit, undo, and
  tenant-scoping invariants hold in exactly one place.

---

## 11. Safety & guards (invariants)

- **No raw SQL from the agent.** The Schema API is the only writer.
- **`is_system` protection.** System types/fields cannot be archived or
  overwritten by the agent.
- **Slug validation.** Keys are snake_case and validated before use.
- **Confirm on destructive ops.** `archive_record_type` requires
  `confirm: true`.
- **Soft-delete only.** Archive hides; nothing is hard-deleted on the agent
  path.
- **Tenant scoping on every query.** No cross-tenant reads or writes.
- **Service-enforced uniqueness/requiredness.** Because EAV columns are shared,
  `is_unique` / `is_required` are enforced in the service, not by DB
  constraints.

---

## 12. Open items / roadmap

- **`computed` field evaluation.** Define the formula language and the read-time
  evaluator (currently reserved as a type, derived on read).
- **Relation-aware filtering.** Extend the query compiler to filter/sort across
  `crm_record_links` (e.g. "Properties whose Tenant is overdue").
- **View/widget config schemas.** Formalize the `config` shapes per view and
  widget kind so the UI and the agent share one contract.
- **Cloud multi-tenant rollout.** The `tenant_id` seam exists; wire workspace →
  tenant mapping end to end.
- **Bulk/import operations.** A batched create path for seeding a type from an
  external source.
- **Field-level audit granularity.** Confirm `0036` captures enough to undo
  partial updates, not just whole-row create/archive.

---

*Source of truth for behavior is the code; if this document and
`CrmSchemaService.ts` disagree, the code wins and this file should be updated.*

