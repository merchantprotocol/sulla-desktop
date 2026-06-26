# Dynamic CRM — Cookbook (Worked Use Cases)

> Companion to [crm-dynamic-architecture.md](crm-dynamic-architecture.md). That
> doc explains *how the engine works*; this one shows *how to drive it* — full,
> copy-pasteable `sulla crm/*` call sequences that stand up real verticals from
> a single natural-language request.
>
> Each recipe is also an **acceptance scenario**: when the dynamic-CRM CLI is
> wired through (see [§ Known gap](#known-gap--cli-routing)), these sequences
> should run top-to-bottom and produce the asserted state.

Every call is `sulla crm/<tool> '<json>'`. The tool surface and field types are
defined in the architecture doc §4/§8; this cookbook assumes them.

---

## Recipe 1 — Property management ("track my rental properties")

**The request.** *"I manage rentals. I want to track properties, the units in
each, who's leasing them, and maintenance tickets — and see occupancy at a
glance."*

**The agent's plan.** 4 types → 3 relationships → seed a couple of records →
a kanban for tickets → an occupancy dashboard.

### 1. Discover first (always)

```
sulla crm/list_record_types '{}'
```

> Contract: call this before any schema change so you never collide with an
> existing type. Assume it returns no `property` type, so we create one.

### 2. Create the types (fields seeded inline)

```
sulla crm/create_record_type '{
  "key": "property", "label": "Property", "icon": "home", "color": "#0ABFBC",
  "description": "A rental property.",
  "fields": [
    { "key": "name",    "label": "Name",    "data_type": "text",     "is_title": true, "is_required": true },
    { "key": "address", "label": "Address", "data_type": "text" },
    { "key": "type",    "label": "Type",    "data_type": "select",
      "config": { "options": ["Single-family", "Duplex", "Multi-family", "Commercial"] } },
    { "key": "purchase_price", "label": "Purchase Price", "data_type": "currency" }
  ]
}'

sulla crm/create_record_type '{
  "key": "unit", "label": "Unit", "icon": "door",
  "fields": [
    { "key": "label",  "label": "Unit",   "data_type": "text",    "is_title": true, "is_required": true },
    { "key": "beds",   "label": "Beds",   "data_type": "number" },
    { "key": "rent",   "label": "Rent",   "data_type": "currency" },
    { "key": "status", "label": "Status", "data_type": "select",
      "config": { "options": ["Vacant", "Occupied", "Make-ready"] } }
  ]
}'

sulla crm/create_record_type '{
  "key": "tenant", "label": "Tenant", "icon": "user",
  "fields": [
    { "key": "name",  "label": "Name",  "data_type": "text",  "is_title": true, "is_required": true },
    { "key": "email", "label": "Email", "data_type": "email" },
    { "key": "phone", "label": "Phone", "data_type": "phone" }
  ]
}'

sulla crm/create_record_type '{
  "key": "ticket", "label": "Maintenance Ticket", "label_plural": "Maintenance Tickets", "icon": "wrench",
  "fields": [
    { "key": "summary",  "label": "Summary",  "data_type": "text", "is_title": true, "is_required": true },
    { "key": "priority", "label": "Priority", "data_type": "select",
      "config": { "options": ["Low", "Normal", "High", "Emergency"] } },
    { "key": "status",   "label": "Status",   "data_type": "select",
      "config": { "options": ["Open", "Scheduled", "In Progress", "Done"] } },
    { "key": "opened_at","label": "Opened",   "data_type": "datetime" }
  ]
}'
```

### 3. Wire the relationships

```
sulla crm/define_relationship '{ "key": "property_units", "from_type": "property", "to_type": "unit",
  "cardinality": "one_to_many", "from_label": "Units", "to_label": "Property" }'
# → returns { id: "<rel_property_units>" }

sulla crm/define_relationship '{ "key": "unit_tenants", "from_type": "unit", "to_type": "tenant",
  "cardinality": "many_to_many", "from_label": "Tenants", "to_label": "Leases" }'

sulla crm/define_relationship '{ "key": "unit_tickets", "from_type": "unit", "to_type": "ticket",
  "cardinality": "one_to_many", "from_label": "Tickets", "to_label": "Unit" }'
```

### 4. Seed and link a record (note the undo token)

```
sulla crm/create_record '{ "record_type": "property",
  "values": { "name": "Maple Court", "address": "12 Maple St", "type": "Duplex", "purchase_price": 480000 } }'
# → { id: "<prop1>", undoToken: "<tok>" }   ← keep tok to offer a clean revert

sulla crm/create_record '{ "record_type": "unit",
  "values": { "label": "Maple Court #1", "beds": 2, "rent": 1850, "status": "Occupied" } }'
# → { id: "<unit1>" }

sulla crm/link_records '{ "relationship_id": "<rel_property_units>",
  "from_record_id": "<prop1>", "to_record_id": "<unit1>" }'
```

### 5. A kanban of tickets + an occupancy dashboard

```
sulla crm/create_view '{ "record_type": "ticket", "name": "Ticket Board", "kind": "kanban",
  "config": { "groupBy": "status", "fields": ["summary", "priority"] } }'

sulla crm/create_dashboard '{ "key": "rentals", "name": "Rentals", "icon": "home" }'
# → { id: "<dash>" }

sulla crm/create_widget '{ "dashboard_id": "<dash>", "record_type": "unit", "name": "Occupancy",
  "kind": "stat", "config": { "metric": "countWhere", "filter": { "status": "Occupied" }, "of": "count" } }'

sulla crm/create_widget '{ "dashboard_id": "<dash>", "record_type": "unit", "name": "Rent Roll by Status",
  "kind": "bar", "config": { "groupBy": "status", "measure": { "field": "rent", "agg": "sum" } } }'
```

### User stories this satisfies

- *As a landlord, I ask in plain English and get a working Property CRM with no
  configuration.*
- *As a landlord, I see live occupancy and rent roll without building a report.*
- *As the agent, every record I create hands me an `undoToken`, so a mistaken
  seed is one `crm/undo` away.*

### Acceptance criteria

- [ ] `list_record_types` now returns `property, unit, tenant, ticket`.
- [ ] `query_records {record_type:"unit", filter:{status:"Occupied"}}` returns the
      linked unit; the occupancy stat widget reads the same count.
- [ ] Archiving `property` requires `confirm:true` and is reversible.
- [ ] `crm/undo` with the property's token removes the seeded property.

---

## Recipe 2 — Fleet maintenance ("don't let a vehicle miss service")

**The request.** *"Track our vehicles and drivers, log every service, and warn
me before the next service is due."*

```
sulla crm/create_record_type '{
  "key": "vehicle", "label": "Vehicle", "icon": "truck",
  "fields": [
    { "key": "name",        "label": "Name",        "data_type": "text", "is_title": true, "is_required": true },
    { "key": "vin",         "label": "VIN",         "data_type": "text", "is_unique": true },
    { "key": "odometer",    "label": "Odometer",    "data_type": "number" },
    { "key": "stage",       "label": "Stage",       "data_type": "select",
      "config": { "options": ["Active", "In Shop", "Reserve", "Retired"] } },
    { "key": "next_service","label": "Next Service", "data_type": "date" }
  ]
}'

sulla crm/create_record_type '{ "key": "driver", "label": "Driver", "icon": "id",
  "fields": [ { "key": "name", "label": "Name", "data_type": "text", "is_title": true, "is_required": true },
              { "key": "license", "label": "License #", "data_type": "text" } ] }'

sulla crm/create_record_type '{ "key": "service", "label": "Service Record", "icon": "wrench",
  "fields": [
    { "key": "summary", "label": "Summary", "data_type": "text", "is_title": true, "is_required": true },
    { "key": "cost",    "label": "Cost",    "data_type": "currency" },
    { "key": "done_at", "label": "Performed","data_type": "datetime" }
  ] }'

sulla crm/define_relationship '{ "key": "vehicle_driver", "from_type": "vehicle", "to_type": "driver",
  "cardinality": "many_to_many", "from_label": "Drivers", "to_label": "Vehicles" }'
sulla crm/define_relationship '{ "key": "vehicle_service", "from_type": "vehicle", "to_type": "service",
  "cardinality": "one_to_many", "from_label": "Service History", "to_label": "Vehicle" }'
```

**The "warn me before service is due" query** — vehicles in service with a
`next_service` date set, soonest first:

```
sulla crm/query_records '{
  "record_type": "vehicle",
  "filter": { "stage": { "notIn": ["Retired"] }, "next_service": { "isSet": true } },
  "sort":   [{ "field": "next_service", "dir": "asc" }],
  "limit":  25
}'
```

**A calendar view of upcoming service** + a lifecycle funnel:

```
sulla crm/create_view '{ "record_type": "vehicle", "name": "Service Calendar", "kind": "calendar",
  "config": { "dateField": "next_service", "title": "name" } }'

sulla crm/create_dashboard '{ "key": "fleet", "name": "Fleet" }'
sulla crm/create_widget '{ "dashboard_id": "<dash>", "record_type": "vehicle", "name": "Fleet by Stage",
  "kind": "funnel", "config": { "groupBy": "stage" } }'
```

### Why this is a good fit for the engine

The whole vertical — 3 types, 2 relationships, a date-driven calendar, a funnel —
is **pure API calls.** No migration, no UI code. The same `query_records`
operator grammar (`isSet`, `notIn`, `gt`) that powers the "service due" query
also powers a future scheduled reminder (loop the query, notify on the head row).

---

## Use-case catalog (the breadth)

Each is a single-request vertical the product CRM doesn't cover. The recipe is
always the same shape: *types → fields → relationships → records → views →
widgets.*

| Vertical | Core types | A signature query/view |
|----------|-----------|------------------------|
| Property management | property, unit, tenant, ticket | occupancy stat; ticket kanban |
| Fleet maintenance | vehicle, driver, service | "service due" date sort; lifecycle funnel |
| Permitting / inspections | permit, inspection, violation | computed "days to expiry"; expiring-soon table |
| Event / catering ops | event, vendor, booking | N:N event↔vendor; confirmed-bookings stat |
| Equipment rental | asset, rental, customer | asset availability; utilization bar |
| Clinical trial intake | participant, visit, consent-form | visit calendar; enrollment funnel |
| Grant tracking | grant, milestone, report | deadline calendar; spend-vs-budget bar |
| Membership / chapters | member, chapter, dues-payment | dues-overdue list; renewals stat |
| Asset compliance | device, certificate, audit | cert-expiry sort; pass/fail funnel |
| Field service jobs | job, technician, part | job kanban; first-time-fix stat |

Every row is reachable from one natural-language request because every
primitive is a tool call.

---

## Patterns worth reusing

- **Discover-before-mutate.** Always `list_record_types` first; treat an existing
  key as a reason to `add_field`, not re-create.
- **Title field is mandatory thinking.** Pick the `is_title` field deliberately —
  it denormalizes into `crm_records.title` and drives every list/sort label.
- **Relations are links, not values.** Model a connection with
  `define_relationship` + `link_records`, never a `text` field holding an id.
- **Operator queries, not client filtering.** Push conditions into
  `query_records.filter` (`{gt,gte,lt,lte,in,notIn,contains,isSet}`) so the EAV
  compiler does the work and the result set stays small (cap 500).
- **Keep the undo token.** Every mutation returns one; surface it so the user (or
  you) can revert a single op cleanly.
- **Two-part feature adds.** A new gated/queried field is only "done" when both
  the type has it *and* any saved view/widget references it.

---

## Known gap — CLI routing

As of 2026-06-26 the `sulla crm/*` CLI commands return
`{"error":"Missing required field \"path\""}` — the dispatcher resolves the
`crm/*` tool name to a generic REST/GraphQL proxy instead of the dynamic-CRM
handler, even though `sulla crm --help` lists the tools correctly. Until that
routing is fixed (likely a category-name collision between the new dynamic-CRM
tools and a pre-existing CRM API proxy), the recipes above are **specifications
and acceptance scenarios**, not yet live-executable from the CLI. The
`CrmSchemaService` they exercise is merged and on `main` (PR #453).

---

*When the CLI path is live, this file is the fastest way to smoke-test the whole
engine: run Recipe 1 top to bottom and check the acceptance boxes.*
