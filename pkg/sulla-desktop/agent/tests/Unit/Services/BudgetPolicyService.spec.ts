// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { BudgetPolicyService } from '../../../services/BudgetPolicyService';

class MemorySettings {
  constructor(public value: unknown = null) {}
  async get(): Promise<unknown> { return this.value; }
  async set(_key: string, value: unknown): Promise<void> { this.value = value; }
}

describe('BudgetPolicyService', () => {
  it('reads the setting and treats expired priority as balanced without writing', async() => {
    // risk: stale human-first/sulla-first modes must not outlive their expiry
    const settings = new MemorySettings({ machine: { priority: 'sulla-first', priorityUntil: '2026-11-16T00:00:00Z' } });
    const service = new BudgetPolicyService(settings, 3000, () => Date.parse('2026-11-17T00:00:00Z'));
    expect((await service.read())?.machine?.priority).toBe('balanced');
    expect(settings.value).toEqual({ machine: { priority: 'sulla-first', priorityUntil: '2026-11-16T00:00:00Z' } });
  });

  it('keeps priority metadata unchanged when Budgeter updates worker and provider policy', async() => {
    // risk: policy writers must not override the human-owned priority control
    const settings = new MemorySettings({ machine: { priority: 'human-first', prioritySetBy: 'jonathon', priorityUntil: '2026-12-01T00:00:00Z' } });
    const service = new BudgetPolicyService(settings);
    const result = await service.setPolicy({ machine: { priority: 'sulla-first', max_concurrent_workers: 2 }, providers: { openai: { pace: 'steady' } } });
    expect(result.machine).toEqual({ priority: 'human-first', prioritySetBy: 'jonathon', priorityUntil: '2026-12-01T00:00:00Z', max_concurrent_workers: 2 });
    expect((settings.value as any).providers.openai.pace).toBe('steady');
  });

  it('fails open for malformed settings and rejects unsupported policy values', async() => {
    // risk: corrupted settings must not enforce malformed limits or persist bad policy
    const settings = new MemorySettings({ machine: { max_concurrent_workers: -1 } });
    const service = new BudgetPolicyService(settings);
    expect(await service.read()).toBeNull();
    await expect(service.setPolicy({ providers: { openai: { pace: 'unlimited' } } })).rejects.toThrow('Invalid budget policy');
  });
});
