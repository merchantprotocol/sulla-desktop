/**
 * Domain model for the organization AI-employee marketplace (Projects task xF3S).
 *
 * An "AI employee" is a pre-configured agent role an organization can browse,
 * understand, and activate (hire). The shape mirrors the native integration
 * catalog (see agent/integrations/types.ts) so the marketplace UX can reuse the
 * same browse / detail / gating patterns.
 *
 * This module is intentionally pure (no IPC, no Vue, no side effects) so it can
 * be unit-tested and typechecked in isolation via tsconfig.agent-check.json.
 */

/** Subscription tiers, ordered from least to most capable (see cloud/overview.md). */
export type SubscriptionTier = 'free' | 'premium_support' | 'enterprise_gateway';

/** Lifecycle state of an activated (hired) AI employee. */
export type AiEmployeeActivationStatus = 'active' | 'paused';

/** A hireable AI employee role in the marketplace catalog. */
export interface AiEmployee {
  /** Stable identifier (kebab-case), unique across the catalog. */
  id: string;
  /** Display name of the role, e.g. "Executive Assistant". */
  name: string;
  /** One-line summary of what this employee does. */
  role: string;
  /** Short description shown on the browse card. */
  description: string;
  /** Longer description shown on the detail view. */
  longDescription?: string;
  /** Grouping used by the marketplace filter, e.g. "Sales". */
  category: string;
  /** Icon asset name (resolved by the renderer), optional. */
  icon?: string;
  /** Minimum subscription tier required to activate this employee. */
  requiredTier: SubscriptionTier;
  /** Ordered capabilities this employee provides. */
  capabilities: string[];
  /** Concrete example tasks a user can delegate. */
  exampleTasks?: string[];
  /** Integration ids (see agent/integrations) this employee relies on. */
  integrationsUsed?: string[];
  /** Display ordering within a category (lower first). */
  sort: number;
  /** Marked as beta. */
  beta?: boolean;
  /** Announced but not yet activatable. */
  comingSoon?: boolean;
  version: string;
  lastUpdated: string;
  developer: string;
}

/** A record of an employee the organization has activated. */
export interface AiEmployeeActivation {
  employeeId: string;
  /** ISO-8601 timestamp of activation. */
  activatedAt: string;
  /** Optional operator/actor who activated it. */
  activatedBy?: string;
  status: AiEmployeeActivationStatus;
}

/** Why an employee cannot currently be activated (null = it can). */
export type ActivationGateReason =
  | { kind: 'coming_soon' }
  | { kind: 'requires_upgrade'; requiredTier: SubscriptionTier }
  | { kind: 'already_active' };

/** Browse-card view model: catalog entry plus computed activation state. */
export interface AiEmployeeCardView {
  employee: AiEmployee;
  eligible: boolean;
  active: boolean;
  /** Non-null when the employee cannot be activated right now. */
  gate: ActivationGateReason | null;
}

/** Active-employee view model: activation joined to its catalog entry. */
export interface ActiveAiEmployeeView {
  employee: AiEmployee;
  activation: AiEmployeeActivation;
}

/** Aggregate view model backing the marketplace + activation UX. */
export interface AiEmployeeMarketplaceView {
  currentTier: SubscriptionTier;
  categories: string[];
  /** All catalog entries with computed gating (browse grid). */
  available: AiEmployeeCardView[];
  /** Currently active/paused employees (manage panel). */
  active: ActiveAiEmployeeView[];
}
