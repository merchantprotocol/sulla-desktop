// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

export type ProviderPace = 'spend' | 'steady' | 'conserve' | 'hard-conserve';
export type MachinePriority = 'human-first' | 'balanced' | 'sulla-first';
export interface BudgetPolicy {
  updatedAt?: string;
  machine?: { priority?: MachinePriority; prioritySetBy?: string; priorityUntil?: string | null; max_concurrent_workers?: number; reason?: string; [key: string]: unknown };
  providers?: Record<string, { pace?: ProviderPace; advice?: string; [key: string]: unknown }>;
}

const PRIORITIES: MachinePriority[] = ['human-first', 'balanced', 'sulla-first'];
const PACES: ProviderPace[] = ['spend', 'steady', 'conserve', 'hard-conserve'];
const POLICY_SETTING = 'budgetPolicy';
interface BudgetPolicySettings {
  get(property: string, defaultValue?: unknown): Promise<unknown>;
  set(property: string, value: unknown, cast?: string): Promise<void>;
}

/** Cached, fail-open access to Budgeter's installation-wide setting. */
export class BudgetPolicyService {
  private cachedAt = 0;
  private cached: BudgetPolicy | null = null;
  constructor(private readonly settings: BudgetPolicySettings = SullaSettingsModel, private readonly ttlMs = 3000, private readonly now = () => Date.now()) {}

  private validate(value: unknown): BudgetPolicy | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const policy = value as BudgetPolicy;
    if (policy.machine !== undefined) {
      if (!policy.machine || typeof policy.machine !== 'object' || Array.isArray(policy.machine)) return null;
      const machine = policy.machine;
      if (machine.priority !== undefined && !PRIORITIES.includes(machine.priority)) return null;
      if (machine.max_concurrent_workers !== undefined && (!Number.isInteger(machine.max_concurrent_workers) || machine.max_concurrent_workers < 0)) return null;
      if (machine.prioritySetBy !== undefined && typeof machine.prioritySetBy !== 'string') return null;
      if (machine.priorityUntil !== undefined && machine.priorityUntil !== null && (typeof machine.priorityUntil !== 'string' || !Number.isFinite(Date.parse(machine.priorityUntil)))) return null;
    }
    if (policy.providers !== undefined) {
      if (!policy.providers || typeof policy.providers !== 'object' || Array.isArray(policy.providers)) return null;
      for (const provider of Object.values(policy.providers)) {
        if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return null;
        if (provider.pace !== undefined && !PACES.includes(provider.pace)) return null;
      }
    }
    return policy;
  }

  async read(): Promise<BudgetPolicy | null> {
    if (this.now() - this.cachedAt < this.ttlMs) return this.cached;
    this.cachedAt = this.now();
    try {
      const policy = this.validate(await this.settings.get(POLICY_SETTING, null));
      if (!policy) return this.cached = null;
      const until = policy.machine?.priorityUntil;
      if (until && Date.parse(until) < this.now()) return this.cached = { ...policy, machine: { ...policy.machine, priority: 'balanced' } };
      return this.cached = policy;
    } catch { return this.cached = null; }
  }

  async setPolicy(input: unknown): Promise<BudgetPolicy> {
    const policy = this.validate(input);
    if (!policy) throw new Error('Invalid budget policy.');
    const stored = this.validate(await this.settings.get(POLICY_SETTING, null));
    const machine = { ...policy.machine };
    for (const key of ['priority', 'prioritySetBy', 'priorityUntil'] as const) {
      const value = stored?.machine?.[key];
      if (value !== undefined) machine[key] = value as never;
      else delete machine[key];
    }
    const next: BudgetPolicy = { ...policy, machine };
    await this.settings.set(POLICY_SETTING, next, 'json');
    this.cached = next;
    this.cachedAt = this.now();
    return next;
  }

  async setPriority(priority: MachinePriority, until?: string): Promise<BudgetPolicy> {
    const current = this.validate(await this.settings.get(POLICY_SETTING, null)) ?? {};
    const next = { ...current, machine: { ...current.machine, priority, prioritySetBy: 'jonathon', priorityUntil: until ?? null } };
    await this.settings.set(POLICY_SETTING, next, 'json');
    this.cached = next;
    this.cachedAt = this.now();
    return next;
  }
}

export const budgetPolicyService = new BudgetPolicyService();
