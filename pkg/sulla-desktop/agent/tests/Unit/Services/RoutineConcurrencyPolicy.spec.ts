// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../database/PostgresClient', () => ({ postgresClient: {} }));
vi.mock('../../../database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn() } }));

import { RoutineConcurrencyPolicy } from '../../../services/RoutineConcurrencyPolicy';

/** In-memory slot store with the same admission semantics as RoutineSlotRepository. */
class FakeSlots {
  readonly held = new Map<string, string>();
  stale = 0;
  countActive = vi.fn(async(kind: string | null) => [...this.held.values()].filter(k => kind === null || k === kind).length);
  reserveUnderLimit = vi.fn(async(limit: number, r: { id: string; kind: string }) => {
    if (this.held.size >= limit) return null;
    this.held.set(r.id, r.kind);
    return r.id;
  });
  delete = vi.fn(async(id: string) => { this.held.delete(id) });
  touch = vi.fn(async() => undefined);
  deleteStale = vi.fn(async() => { const n = this.stale; this.stale = 0; return n });
}

function policy(limitSetting: unknown, slots = new FakeSlots()) {
  let next = 0;
  const sleep = vi.fn(async() => { slots.held.clear() }); // capacity frees up while we wait
  const instance = new RoutineConcurrencyPolicy({
    slots:       slots as any,
    readSetting: async() => limitSetting,
    newSlotId:   () => `slot-${ ++next }`,
    sleep,
  });
  return { instance, slots, sleep };
}

describe('RoutineConcurrencyPolicy (characterization)', () => {
  // risk: capacity — the stored shared limit wins over the caller-supplied limit.
  it('admits up to the stored worker limit and ignores the per-call limit', async() => {
    const { instance } = policy(2);
    await expect(instance.acquire('execution', 99)).resolves.toBe('slot-1');
    await expect(instance.acquire('review', 99)).resolves.toBe('slot-2');
    await expect(instance.acquire('execution', 99)).resolves.toBeNull();
  });

  it('resolveLimit is the total limit regardless of kind', async() => {
    const { instance } = policy(3);
    await expect(instance.resolveLimit('planning', 7)).resolves.toBe(await instance.resolveTotalLimit());
  });

  // risk: availability — backpressure queues instead of failing, reclaiming stale slots before each attempt.
  it('waits for capacity instead of failing and reclaims stale slots first', async() => {
    const { instance, slots, sleep } = policy(1);
    await instance.acquire('execution', 1);
    await expect(instance.acquireWhenAvailable('execution', 1, {}, 10)).resolves.toBe('slot-3');
    expect(sleep).toHaveBeenCalledWith(100); // poll interval floors at 100 ms
    expect(slots.deleteStale).toHaveBeenCalledTimes(2);
  });

  it('floors stale minutes at 1 and whole minutes', async() => {
    const { instance, slots } = policy(1);
    await instance.reclaimStale(0.4);
    await instance.reclaimStale(12.9);
    expect(slots.deleteStale.mock.calls).toEqual([[1], [12]]);
  });

  it('passes owner and task context, defaulting to null', async() => {
    const { instance, slots } = policy(5);
    await instance.acquire('repair', 1, { owner: 'w' });
    expect(slots.reserveUnderLimit).toHaveBeenCalledWith(5, { id: 'slot-1', kind: 'repair', owner: 'w', taskId: null });
  });

  it('release frees capacity and runningCount filters by kind', async() => {
    const { instance } = policy(2);
    const a = await instance.acquire('execution', 2);
    await instance.acquire('review', 2);
    await expect(instance.runningCount('review')).resolves.toBe(1);
    await instance.release(a!);
    await expect(instance.runningCount()).resolves.toBe(1);
  });

  it('keeps the static facade for existing callers', () => {
    expect(typeof RoutineConcurrencyPolicy.acquire).toBe('function');
    expect(RoutineConcurrencyPolicy.shared()).toBe(RoutineConcurrencyPolicy.shared());
  });
});
