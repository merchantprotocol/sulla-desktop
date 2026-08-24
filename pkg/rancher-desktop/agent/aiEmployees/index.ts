/**
 * Pure selectors and reducers for the organization AI-employee marketplace.
 *
 * No IPC / Vue / side effects — this is the shared domain logic the renderer
 * composable and any main-process handler both build on. Verified in isolation
 * via tsconfig.agent-check.json.
 */
import { aiEmployeeCatalog } from './catalog';
import type {
  ActivationGateReason,
  ActiveAiEmployeeView,
  AiEmployee,
  AiEmployeeActivation,
  AiEmployeeCardView,
  AiEmployeeMarketplaceView,
  SubscriptionTier,
} from './types';

export * from './types';
export { aiEmployeeCatalog } from './catalog';

/** Ordering of subscription tiers (a higher tier includes everything below). */
const TIER_RANK: Record<SubscriptionTier, number> = {
  free:               0,
  premium_support:    1,
  enterprise_gateway: 2,
};

export function tierRank(tier: SubscriptionTier): number {
  return TIER_RANK[tier] ?? 0;
}

/** True when currentTier satisfies the required tier. */
export function meetsTier(required: SubscriptionTier, current: SubscriptionTier): boolean {
  return tierRank(current) >= tierRank(required);
}

/** All catalog employees, sorted by category, then sort, then name. */
export function listAiEmployees(): AiEmployee[] {
  return Object.values(aiEmployeeCatalog).sort((a, b) =>
    a.category.localeCompare(b.category)
    || a.sort - b.sort
    || a.name.localeCompare(b.name));
}

export function getAiEmployee(id: string): AiEmployee | undefined {
  return aiEmployeeCatalog[id];
}

/** Distinct categories present in the catalog, alphabetically. */
export function listCategories(): string[] {
  return Array.from(new Set(listAiEmployees().map(e => e.category))).sort();
}

function isActive(activations: AiEmployeeActivation[], id: string): boolean {
  return activations.some(a => a.employeeId === id);
}

/**
 * Compute why an employee cannot be activated right now, or null if it can.
 * Precedence: already active > coming soon > tier upgrade required.
 */
export function activationGate(
  employee: AiEmployee,
  currentTier: SubscriptionTier,
  activations: AiEmployeeActivation[] = [],
): ActivationGateReason | null {
  if (isActive(activations, employee.id)) {
    return { kind: 'already_active' };
  }
  if (employee.comingSoon) {
    return { kind: 'coming_soon' };
  }
  if (!meetsTier(employee.requiredTier, currentTier)) {
    return { kind: 'requires_upgrade', requiredTier: employee.requiredTier };
  }
  return null;
}

/** True when the employee can be activated under the current tier/state. */
export function canActivate(
  employee: AiEmployee,
  currentTier: SubscriptionTier,
  activations: AiEmployeeActivation[] = [],
): boolean {
  return activationGate(employee, currentTier, activations) === null;
}

/**
 * Pure reducer: activate (hire) an employee. Idempotent — re-activating an
 * already-active employee returns the same list reference. Throws for unknown
 * employees; callers should check canActivate first for user-facing gating.
 */
export function activateEmployee(
  activations: AiEmployeeActivation[],
  employeeId: string,
  opts: { at: string; by?: string },
): AiEmployeeActivation[] {
  const employee = getAiEmployee(employeeId);
  if (!employee) {
    throw new Error(`Unknown AI employee: ${ employeeId }`);
  }
  if (isActive(activations, employeeId)) {
    return activations;
  }
  const activation: AiEmployeeActivation = {
    employeeId,
    activatedAt: opts.at,
    status:      'active',
    ...(opts.by ? { activatedBy: opts.by } : {}),
  };
  return [...activations, activation];
}

/** Pure reducer: deactivate (release) an employee. Idempotent. */
export function deactivateEmployee(
  activations: AiEmployeeActivation[],
  employeeId: string,
): AiEmployeeActivation[] {
  return activations.filter(a => a.employeeId !== employeeId);
}

/** Build the full marketplace + activation view model for the UX. */
export function buildMarketplaceView(input: {
  currentTier: SubscriptionTier;
  activations?: AiEmployeeActivation[];
}): AiEmployeeMarketplaceView {
  const activations = input.activations ?? [];
  const available: AiEmployeeCardView[] = listAiEmployees().map((employee) => {
    return {
      employee,
      eligible: meetsTier(employee.requiredTier, input.currentTier) && !employee.comingSoon,
      active:   isActive(activations, employee.id),
      gate:     activationGate(employee, input.currentTier, activations),
    };
  });
  const active: ActiveAiEmployeeView[] = activations
    .map((activation) => {
      const employee = getAiEmployee(activation.employeeId);

      return employee ? { employee, activation } : null;
    })
    .filter((v): v is ActiveAiEmployeeView => v !== null);

  return {
    currentTier: input.currentTier,
    categories:  listCategories(),
    available,
    active,
  };
}
