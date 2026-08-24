# Organization AI Employee Marketplace & Activation UX

Projects task: **xF3S** (project zHuT / epic m5rT). Status: domain foundation landed;
renderer UI specified below as the immediate follow-up.

## Goal

Let an organization **browse the AI employees it can hire/activate**, understand what each
one does, see its **subscription requirement**, **activate** eligible employees, and
**manage currently active** employees — mirroring the app's existing integration and
routines-marketplace patterns.

## What shipped in this PR (verified)

Pure, framework-free domain module under `pkg/rancher-desktop/agent/aiEmployees/`:

- `types.ts` — `AiEmployee`, `AiEmployeeActivation`, `SubscriptionTier`
  (`free` | `premium_support` | `enterprise_gateway`, per `cloud/overview.md`),
  `ActivationGateReason`, and the view models `AiEmployeeCardView` /
  `ActiveAiEmployeeView` / `AiEmployeeMarketplaceView`.
- `catalog.ts` — initial roster of 8 roles keyed by id (Executive Assistant,
  Customer Support Agent, Bookkeeper, Data Analyst, Sales Development Rep,
  Marketing Manager, Recruiter, and a coming-soon IT Helpdesk), each with
  capabilities, example tasks, referenced integrations, and a `requiredTier`.
- `index.ts` — pure selectors/reducers: `listAiEmployees`, `getAiEmployee`,
  `listCategories`, `meetsTier`, `activationGate`, `canActivate`,
  `activateEmployee` (idempotent), `deactivateEmployee` (idempotent), and
  `buildMarketplaceView` (the single view model the UI renders).
- `__tests__/aiEmployees.test.ts` — 11 tests covering catalog integrity, tier
  eligibility, gating precedence (already-active > coming-soon > upgrade),
  reducer idempotency, and the marketplace-view split.

Verification: `tsc -p tsconfig.agent-check.json` (scoped) → 0 errors; jest → 11/11 pass.

The activation gate has a deliberate precedence: **already-active > coming-soon >
requires-upgrade**, so an already-hired employee never shows an upsell.

## Follow-up: renderer UI (Vue)

Model the UI on the existing routines marketplace
(`components/routines/MarketplaceTab.vue` / `MarketplaceDetail.vue` /
`MarketplaceStrip.vue`, driven by `composables/useMarketplace.ts`) and the agent
integration pages (`pages/AgentIntegrations.vue` / `AgentIntegrationDetail.vue`).

### Composable — `composables/useAiEmployees.ts`

Reactive wrapper over the domain module and an IPC-backed activation store:

- state: `currentTier`, `activations`, derived `view = buildMarketplaceView({ currentTier, activations })`.
- actions: `activate(id)`, `deactivate(id)`, `pause(id)` — each calls `canActivate`
  first, invokes the main-process handler, then updates local state optimistically
  with rollback on error.
- getters: `available`, `active`, `categories`, `byCategory(cat)`.

### IPC contract — `typings/electron-ipc.d.ts`

- `ai-employees/list` → `AiEmployee[]` (from `listAiEmployees()`).
- `ai-employees/activations` → `AiEmployeeActivation[]` (persisted).
- `ai-employees/activate` `{ id }` → `AiEmployeeActivation` (server re-checks
  `canActivate` against the account's real tier — never trust the renderer).
- `ai-employees/deactivate` `{ id }` → `{ ok: true }`.

Persist activations next to existing account/subscription state; resolve
`currentTier` from the real Sulla Cloud subscription (see `components/account/SullaCloudCard.vue`).

### Components / pages

- `pages/AiEmployeesHome.vue` — top-level page. Header + search + category filter;
  a **"Active" section** (manage panel) above the **browse grid**. Register in the
  app router/nav next to Routines/Projects (`pages/agent/AgentRouter.vue`).
- `components/aiEmployees/AiEmployeeCard.vue` — one `AiEmployeeCardView`. Shows
  name/role/category, a tier badge, and a primary action derived from `gate`:
  - `gate === null` → **Activate**
  - `already_active` → **Manage** (or Active pill)
  - `coming_soon` → disabled **Coming soon**
  - `requires_upgrade` → **Upgrade to {tier}** linking to the subscription flow.
- `components/aiEmployees/AiEmployeeDetail.vue` — full description, capabilities,
  example tasks, integrations used, subscription requirement, and the same
  gate-driven action.
- `components/aiEmployees/ActiveEmployeeStrip.vue` — a row in the Active section
  with pause/release controls and activation metadata.

### States to handle

Empty catalog; empty active list (onboarding nudge); activation in-flight
(spinner + disabled action); activation error (toast + rollback); tier upgrade
required (route to subscription); coming-soon (non-interactive).

### i18n

Add keys under `assets/translations/en-us.yaml` (and `zh-hans.yaml`) namespaced
`aiEmployees.*`, following the existing marketplace/integration key style.

## Acceptance criteria → mapping

1. Browse AI employees → `listAiEmployees()` / grid of `AiEmployeeCard`.
2. Understand what each does → `AiEmployeeDetail` (description, capabilities, example tasks).
3. See subscription requirements → `requiredTier` badge + `requires_upgrade` gate.
4. Activate eligible employees → `canActivate` + `ai-employees/activate` + `activateEmployee`.
5. Manage active employees → Active section from `buildMarketplaceView().active` + deactivate/pause.

## Notes / decisions

- Renderer UI is deferred to this follow-up because it could not be iterated and
  build-verified within the current worker environment; the domain layer it binds
  to is landed, typechecked, and unit-tested so the UI is a thin, testable shell.
- Subscription tiers are intentionally limited to those documented in
  `cloud/overview.md`; do not invent tiers or pricing.
