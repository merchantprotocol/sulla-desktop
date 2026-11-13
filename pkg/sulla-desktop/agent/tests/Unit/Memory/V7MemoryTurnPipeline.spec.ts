// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { V7MemoryRunLog, V7MemoryScheduler, V7MemoryTurnPipeline, type V7MemoryAgents, type V7MemoryTurnInput, type V7MemoryStore } from '../../../memory/V7MemoryTurnPipeline';
import { SubconsciousWriterGate } from '../../../services/SubconsciousWriterGate';

const write = { episodes: [{ id: 'episode' }], items: [], evidence: [] } as any;
const input = (turnId = 'turn-1'): V7MemoryTurnInput => ({ state: { messages: [{ role: 'user', content: 'A substantial statement worth remembering.' }], metadata: {} }, threadId: 'thread-1', turnId, contextWindow: 30, coalescedTurns: 1 });
const store = (append = vi.fn(async () => ({ accepted: true, episodes: 1, items: 0, evidence: 0 }))) => ({ validate: vi.fn(async () => ({ ok: true, write })), append }) as unknown as V7MemoryStore;
const agents = (overrides: Partial<V7MemoryAgents> = {}): V7MemoryAgents => ({ elephantDraft: vi.fn(async () => '{"draft":true}'), goldfish: vi.fn(async () => '{"issues":[{"kind":"vague_text","note":"clarify"}]}'), elephantFinal: vi.fn(async () => '{"final":true}'), ...overrides });

describe('v7 per-turn memory behavior', () => {
  it.each([
    ['goldfish fails', { goldfish: vi.fn(async () => { throw new Error('offline') }) }, 2],
    ['elephant-final fails', { elephantFinal: vi.fn(async () => { throw new Error('offline') }) }, 3],
  ])('appends the validated draft exactly once when %s', async (_failure, failure, calls) => {
    // risk: memory loss if a downstream model failure prevents a valid draft from being persisted
    const writer = store();
    const model = agents(failure);
    const pipeline = new V7MemoryTurnPipeline(model, writer, new V7MemoryRunLog(() => undefined));
    await expect(pipeline.run(input())).resolves.toMatchObject({ outcome: 'draft-fallback', calls, covered: true });
    expect(writer.append).toHaveBeenCalledTimes(1);
    expect(writer.append).toHaveBeenCalledWith(write);
  });

  it('coalesces turns during an active run and starts one latest-wins run with a widened window', async () => {
    // risk: concurrent completions duplicate writes or silently skip newer turns
    let release!: () => void;
    const first = new Promise<void>(resolve => { release = resolve; });
    const runs: V7MemoryTurnInput[] = [];
    const pipeline = { run: vi.fn(async (value: V7MemoryTurnInput) => { runs.push(value); if (runs.length === 1) await first; return { outcome: 'draft' as const, calls: 1, covered: true }; }) };
    const scheduler = new V7MemoryScheduler(pipeline, { run: task => task() }, new V7MemoryRunLog(() => undefined));
    const state = { messages: Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `${i}` })), metadata: {} };
    scheduler.submit('thread', state, 'turn-1');
    await Promise.resolve();
    scheduler.submit('thread', state, 'turn-2');
    for (let i = 0; i < 35; i++) state.messages.push({ role: 'user', content: `latest-${i}` });
    scheduler.submit('thread', state, 'turn-3');
    expect(scheduler.snapshot('thread')).toMatchObject({ running: true, pendingTurns: 2 });
    release();
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1]).toMatchObject({ turnId: 'turn-3', coalescedTurns: 2, contextWindow: 37 });
    expect(runs[1].state.messages).toHaveLength(75);
  });

  it('bounds the writer queue, drops its oldest waiter and expires stale waiters', async () => {
    // risk: a burst of subconscious writers starves foreground model calls indefinitely
    let now = 0;
    const gate = new SubconsciousWriterGate({ maxConcurrent: 1, maxQueue: 2, maxWaitMs: 5, now: () => now });
    let release!: () => void;
    const active = gate.run(() => new Promise<void>(resolve => { release = resolve; }));
    let firstStarted = false;
    const oldest = gate.run(async () => { firstStarted = true; });
    const second = gate.run(async () => undefined);
    const newest = gate.run(async () => undefined);
    await expect(oldest).rejects.toMatchObject({ reason: 'dropped' });
    expect(gate.snapshot()).toEqual({ active: 1, waiting: 2 });
    now = 6;
    release();
    await active;
    await expect(second).rejects.toMatchObject({ reason: 'expired' });
    await expect(newest).rejects.toMatchObject({ reason: 'expired' });
    expect(firstStarted).toBe(false);
    expect(gate.snapshot()).toEqual({ active: 0, waiting: 0 });
  });
});
