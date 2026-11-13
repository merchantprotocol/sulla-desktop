// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import {
  DreamOutputValidator,
  DreamWindowPolicy,
  MAX_DREAM_WINDOW_MS,
  V7Dreamer,
  type DreamBatch,
  type DreamContext,
  type DreamCursorStore,
  type DreamModel,
  type DreamWindow,
  type V7DreamStore,
  type ValidatedDreamWrite,
} from '../../../memory/V7Dreamer';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 13, 15, 5, 0);

const EPISODE = { id: `${ NOW - 600_000 }-user-1`, ts: NOW - 600_000, source: 'user', text: 'Jonathon wants one Dreamer, batched hourly.', keys: ['sulla'], sentiment: 'neutral' };
const CONTEXT: DreamContext = {
  subjects:     [{ slug: 'sulla', name: 'Sulla', kind: 'project' }, { slug: 'global', name: 'Global', kind: 'global' }],
  currentItems: [
    { id: '1794000000000-dream-1', kind: 'conclusion', ptype: null, text: 'Old inferred theme', why: null, scope: ['sulla'], origin: 'model_inferred', ts: 1794000000000, supersedes: null },
    { id: '1794000000000-user-1', kind: 'policy', ptype: 'do', text: 'User rule', why: null, scope: ['sulla'], origin: 'user_stated', ts: 1794000000000, supersedes: null },
  ],
};

class FakeStore implements V7DreamStore {
  windows: DreamWindow[] = [];
  appended: ValidatedDreamWrite[] = [];
  constructor(public batch: DreamBatch = { episodes: [EPISODE], items: [] }) {}
  async loadWindow(window: DreamWindow): Promise<DreamBatch> {
    this.windows.push(window);
    return this.batch;
  }
  async loadContext(): Promise<DreamContext> {
    return CONTEXT;
  }
  async appendDream(write: ValidatedDreamWrite) {
    this.appended.push(write);
    return { items: write.items.length, evidence: write.evidence.length };
  }
}

class FakeCursor implements DreamCursorStore {
  constructor(public lastEnd: number | null = null, public interval = 60) {}
  async getLastWindowEnd() { return this.lastEnd }
  async setLastWindowEnd(ms: number) { this.lastEnd = ms }
  async getIntervalMinutes() { return this.interval }
}

class CountingModel implements DreamModel {
  calls = 0;
  release: (() => void) | null = null;
  constructor(private readonly reply: string | null, private readonly gated = false) {}
  async dream(): Promise<string | null> {
    this.calls++;
    if (this.gated) await new Promise<void>(resolve => { this.release = resolve });
    return this.reply;
  }
}

const GOOD_REPLY = JSON.stringify({
  items: [{ ptype: 'direction', text: 'Memory runs as elephant + goldfish + one batching Dreamer.', why: null, scope: ['sulla'], supersedes: '1794000000000-dream-1', evidence: [{ episode_id: EPISODE.id, role: 'origin' }] }],
});

function dreamer(store: FakeStore, cursor: FakeCursor, model: DreamModel, logs: string[] = [], now = NOW) {
  return new V7Dreamer({ store, cursor, model, now: () => now, log: line => logs.push(line) });
}

describe('V7Dreamer orchestration', () => {
  it('makes exactly one model call for a non-empty window and advances the cursor', async() => {
    // risk: data accuracy — a batch must cost one call and be written once
    const store = new FakeStore();
    const cursor = new FakeCursor(NOW - HOUR);
    const model = new CountingModel(GOOD_REPLY);
    const logs: string[] = [];

    const result = await dreamer(store, cursor, model, logs).run({ trigger: 'routine' });

    expect(result.outcome).toBe('dreamed');
    expect(model.calls).toBe(1);
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0].items[0]).toMatchObject({ id: `${ NOW }-dream-1`, ts: NOW, supersedes: '1794000000000-dream-1' });
    expect(cursor.lastEnd).toBe(NOW);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0].replace('[V7Dreamer] ', ''))).toMatchObject({ outcome: 'dreamed', modelCalls: 1, memoriesRead: { episodes: 1, items: 0 } });
  });

  it('skips an empty window with zero model calls and still advances the cursor', async() => {
    // risk: cost — an idle hour must not spend a model call
    const store = new FakeStore({ episodes: [], items: [] });
    const cursor = new FakeCursor(NOW - HOUR);
    const model = new CountingModel(GOOD_REPLY);

    const result = await dreamer(store, cursor, model).run();

    expect(result.outcome).toBe('skipped_empty');
    expect(model.calls).toBe(0);
    expect(store.appended).toHaveLength(0);
    expect(cursor.lastEnd).toBe(NOW);
  });

  it('never runs two dreams at once: a tick during an in-flight run is skipped', async() => {
    // risk: duplicate side effects — overlapping ticks must not double-dream
    const store = new FakeStore();
    const cursor = new FakeCursor(NOW - HOUR);
    const model = new CountingModel(GOOD_REPLY, true);
    const subject = dreamer(store, cursor, model);

    const first = subject.run({ trigger: 'routine' });
    await new Promise(resolve => setImmediate(resolve));
    expect(subject.isRunning()).toBe(true);
    const second = await subject.run({ trigger: 'routine', force: true });
    expect(second.outcome).toBe('skipped_in_flight');
    expect(second.modelCalls).toBe(0);

    model.release!();
    expect((await first).outcome).toBe('dreamed');
    expect(model.calls).toBe(1);
    expect(store.appended).toHaveLength(1);
    expect(subject.isRunning()).toBe(false);
  });

  it('skips a tick that is not due under the configured interval, unless forced', async() => {
    // risk: cadence — dreamerIntervalMinutes must actually throttle the hourly trigger
    const store = new FakeStore();
    const cursor = new FakeCursor(NOW - HOUR, 180);
    const model = new CountingModel(GOOD_REPLY);

    expect((await dreamer(store, cursor, model).run()).outcome).toBe('skipped_not_due');
    expect(store.windows).toHaveLength(0);
    expect(model.calls).toBe(0);

    expect((await dreamer(store, cursor, model).run({ force: true })).outcome).toBe('dreamed');
    expect(model.calls).toBe(1);
  });

  it('covers a long gap with ONE batch capped at 24 h, then the next tick only sees the new hour', async() => {
    // risk: data accuracy — sleep/restart must not backfill one run per missed tick
    const store = new FakeStore();
    const cursor = new FakeCursor(NOW - 3 * 24 * HOUR);
    const model = new CountingModel(GOOD_REPLY);

    await dreamer(store, cursor, model).run();
    expect(store.windows).toEqual([{ fromTs: NOW - MAX_DREAM_WINDOW_MS, toTs: NOW }]);
    expect(model.calls).toBe(1);

    await dreamer(store, cursor, model, [], NOW + HOUR).run();
    expect(store.windows[1]).toEqual({ fromTs: NOW, toTs: NOW + HOUR });
    expect(model.calls).toBe(2);
  });

  it('keeps the cursor when the model output is rejected so the window is retried', async() => {
    // risk: data loss — a bad dream must not silently skip an hour of memories
    const store = new FakeStore();
    const cursor = new FakeCursor(NOW - HOUR);
    const model = new CountingModel('{"items":[{"text":"x"}]}');

    const result = await dreamer(store, cursor, model).run();

    expect(result.outcome).toBe('rejected');
    expect(model.calls).toBe(1);
    expect(store.appended).toHaveLength(0);
    expect(cursor.lastEnd).toBe(NOW - HOUR);
  });

  it('reports a store failure as failed without throwing and keeps the cursor', async() => {
    // risk: availability — a DB error must not crash the routine or lose the window
    const store = new FakeStore();
    store.appendDream = async() => { throw new Error('db down') };
    const cursor = new FakeCursor(NOW - HOUR);

    const result = await dreamer(store, cursor, new CountingModel(GOOD_REPLY)).run();

    expect(result).toMatchObject({ outcome: 'failed', reason: 'db down', modelCalls: 1 });
    expect(cursor.lastEnd).toBe(NOW - HOUR);
  });
});

describe('DreamWindowPolicy', () => {
  const policy = new DreamWindowPolicy();

  it('starts a first run one interval back and clamps bad interval settings to the default', () => {
    // risk: data accuracy — the first dream reads the last hour, not the whole history
    expect(policy.select(NOW, null, HOUR)).toEqual({ fromTs: NOW - HOUR, toTs: NOW });
    expect(DreamWindowPolicy.intervalMs('nonsense')).toBe(HOUR);
    expect(DreamWindowPolicy.intervalMs(0)).toBe(HOUR);
    expect(DreamWindowPolicy.intervalMs(120)).toBe(2 * HOUR);
  });

  it('treats an hourly cron tick that lands slightly early as due', () => {
    // risk: cadence — clock jitter must not skip every other hour
    expect(policy.isDue(NOW, NOW - HOUR + 30_000, HOUR)).toBe(true);
    expect(policy.isDue(NOW, NOW - 10 * 60_000, HOUR)).toBe(false);
  });
});

describe('DreamOutputValidator', () => {
  const validator = new DreamOutputValidator();
  const batch: DreamBatch = { episodes: [EPISODE], items: [] };
  const item = (overrides: Record<string, unknown>) => JSON.stringify({ items: [{ ptype: null, text: 'A theme', why: null, scope: ['sulla'], supersedes: null, evidence: [{ episode_id: EPISODE.id, role: 'reinforces' }], ...overrides }] });

  it('refuses to supersede a rule the human stated', () => {
    // risk: permissions — an inferred dream must never overwrite a user rule
    expect(() => validator.validate(item({ supersedes: '1794000000000-user-1' }), batch, CONTEXT, NOW)).toThrow(/model-inferred/);
  });

  it('refuses always_on, invented ids and evidence outside the window', () => {
    // risk: permissions — the model cannot pin itself into every prompt or cite unseen episodes
    expect(() => validator.validate(item({ always_on: true }), batch, CONTEXT, NOW)).toThrow(/unsupported fields/);
    expect(() => validator.validate(item({ id: 'x' }), batch, CONTEXT, NOW)).toThrow(/unsupported fields/);
    expect(() => validator.validate(item({ evidence: [{ episode_id: 'other-ep', role: 'origin' }] }), batch, CONTEXT, NOW)).toThrow(/this window/);
    expect(() => validator.validate(item({ evidence: [] }), batch, CONTEXT, NOW)).toThrow(/evidence/);
    expect(() => validator.validate(item({ scope: ['unknown'] }), batch, CONTEXT, NOW)).toThrow(/known subjects/);
  });

  it('accepts a fenced empty reply as a no-op dream', () => {
    // risk: data accuracy — "nothing durable" is a valid outcome, not an error
    expect(validator.validate('```json\n{"items":[]}\n```', batch, CONTEXT, NOW)).toEqual({ items: [], evidence: [] });
  });
});


describe('short Dreamer intervals', () => {
  it('does not let scheduling slack erase a one-minute cadence', () => {
    const policy = new DreamWindowPolicy();
    expect(policy.isDue(NOW, NOW, 60_000)).toBe(false);
    expect(policy.isDue(NOW + 30_000, NOW, 60_000)).toBe(false);
    expect(policy.isDue(NOW + 60_000, NOW, 60_000)).toBe(true);
  });
});
