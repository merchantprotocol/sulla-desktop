# Projects domain kernel (dHAe Phase 1)

Pure, framework-free primitives for the Projects work-graph. **No SQL, no Electron, no
persistence imports** — everything here is unit-testable in isolation.

## Phase 1 contents

| Value object | Purpose | Grounded in |
|---|---|---|
| `TaskId` | Work-item identity (slug, e.g. `YceX`) | `WorkItemsModel` id shape |
| `LaneKey` | Stable, immutable lane column key | `WorkLaneDefinitionModel` `lane_key` |
| `SemanticRole` | Stage-independent lane meaning | `WorkLaneSemanticRole`, `REQUIRED_WORK_LANE_ROLES`, `COMPATIBILITY_ROLE_BY_KEY` |
| `TaskStatus` | Task lifecycle status | `WorkItemsModel` status set + default lane role map, including manual `parked` |
| `ArtifactGeneration` | Monotonic lane-entry / custody generation | `scope_generation` (`WorkflowExecutionModel`), review generation hash |

Characterization tests reproduce the exact canonical constants (the seven semantic roles,
the required-role set, the lane-key -> role map, and the nine default statuses and their
role mapping) so drift from the SQL models is caught.

- Immutable `Project`, `Epic`, `Task`, and `Board` aggregates hold invariants without persistence.
- `LifecycleTransition` emits generation-scoped domain events.
- `LifecyclePolicy` evaluates dependencies, WIP, leases, durable waits, and custody from facts
  supplied by the application layer; it performs no reads or writes itself.
- `DispatchLease`, `Dependency`, `DurableWait`, `CustodyReceipt`, and `DomainEvent` model the
  lifecycle concepts that were previously coupled to SQL models and orchestration services.
- `LegacyProjectsMapper` accepts structural legacy records without importing their SQL-backed
  model modules. Existing adapters can adopt it incrementally without public tool or IPC changes.
- Boundary tests fail if production domain files import database, Electron, tool, or service code.

## Deliberately deferred

Repository interfaces, UnitOfWork, Postgres adapters, production tool/IPC routing, outbox-backed
orchestration, and runtime schema changes belong to Phases 2-4. This branch does not modify those
surfaces. Migrated-Postgres behavior parity is therefore a Phase 2 gate, not hidden inside Phase 1.

These require behavior reverse-engineering of the SQL models and a migrated-Postgres test run,
tracked under task dHAe / YceX.
