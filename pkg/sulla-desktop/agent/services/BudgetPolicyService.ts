// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { readFile, writeFile } from 'fs/promises';

export type ProviderPace = 'spend' | 'steady' | 'conserve' | 'hard-conserve';
export interface BudgetPolicy {
  updatedAt?: string;
  machine?: { priority?: 'human-first' | 'balanced' | 'sulla-first'; prioritySetBy?: string; priorityUntil?: string | null; max_concurrent_workers?: number; reason?: string };
  providers?: Record<string, { pace?: ProviderPace; advice?: string; [key: string]: unknown }>;
}

/** Cached, fail-open access to Budgeter's shared policy. */
export class BudgetPolicyService {
  private cachedAt = 0;
  private cached: BudgetPolicy | null = null;
  constructor(private readonly path = '/mnt/sulla-files/Memory/sulla/budget-policy.json', private readonly ttlMs = 3000, private readonly now = () => Date.now()) {}

  async read(): Promise<BudgetPolicy | null> {
    if (this.now() - this.cachedAt < this.ttlMs) return this.cached;
    this.cachedAt = this.now();
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return this.cached = null;
      const policy = parsed as BudgetPolicy;
      if (policy.machine?.max_concurrent_workers !== undefined && (!Number.isInteger(policy.machine.max_concurrent_workers) || policy.machine.max_concurrent_workers < 0)) return this.cached = null;
      return this.cached = policy;
    } catch { return this.cached = null; }
  }

  async setPriority(priority: 'human-first' | 'balanced' | 'sulla-first', until?: string): Promise<BudgetPolicy> {
    const policy = await this.read() ?? {};
    const next = { ...policy, machine: { ...policy.machine, priority, prioritySetBy: 'jonathon', priorityUntil: until ?? null } };
    await writeFile(this.path, `${ JSON.stringify(next, null, 2) }\n`, { encoding: 'utf8', mode: 0o600 });
    this.cached = next;
    this.cachedAt = this.now();
    return next;
  }
}

export const budgetPolicyService = new BudgetPolicyService();
