// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import {
  DreamDuplicateSweeper,
  MAX_SWEEP_EPISODES,
  type DuplicateSweepCursor,
  type DuplicateSweepStore,
  type SweepEpisode,
  type SweepSubject,
} from '../../../memory/V7DuplicateSweeper';
import {
  V7Dreamer,
  type DreamBatch,
  type DreamContext,
  type DreamCursorStore,
  type DreamModel,
  type DreamWindow,
  type V7DreamStore,
  type ValidatedDreamWrite,
} from '../../../memory/V7Dreamer';

const JOB_A = 'agent-job-1795498075109-109';
const JOB_B = 'agent-job-1795498075109-110';
const NOW = Date.UTC(2026, 10, 23, 20, 22, 0);

class FakeSweepStore implements DuplicateSweepStore {
  readonly calls: Array<{ oldId: string; keepId: string; runId: string; nowTs: number }> = [];
  readonly queries: Array<{ limit: number; beforeTs?: number }> = [];
  subjectLoads = 0;

  constructor(public readonly episodes: SweepEpisode[], public readonly subjects: SweepSubject[] = []) {}

  async loadSweepEpisodes(limit: number, beforeTs?: number): Promise<SweepEpisode[]> {
    this.queries.push({ limit, beforeTs });
    return this.episodes
      .filter(episode => episode.superseded_by === null && (beforeTs === undefined || episode.ts < beforeTs))
      .sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id))
      .slice(0, limit);
  }

  async loadSubjects(): Promise<SweepSubject[]> {
    this.subjectLoads++;
    return this.subjects;
  }

  async supersedeEpisode(oldId: string, keepId: string, runId: string, nowTs: number): Promise<boolean> {
    this.calls.push({ oldId, keepId, runId, nowTs });
    const old = this.episodes.find(episode => episode.id === oldId);
    const keep = this.episodes.find(episode => episode.id === keepId);
    if (!old || !keep || old.superseded_by !== null || old.source === 'user' || old.hasEvidence || keep.superseded_by !== null) return false;
    old.superseded_by = keepId;
    return true;
  }
}

class FakeSweepCursor implements DuplicateSweepCursor {
  constructor(public beforeTs: number | null = null) {}
  async getBeforeTs() { return this.beforeTs }
  async setBeforeTs(beforeTs: number | null) { this.beforeTs = beforeTs }
}

class FakeDreamStore implements V7DreamStore {
  constructor(private readonly batch: DreamBatch) {}
  async loadWindow(_window: DreamWindow): Promise<DreamBatch> { return this.batch }
  async loadContext(): Promise<DreamContext> { return { subjects: [], currentItems: [] } }
  async appendDream(write: ValidatedDreamWrite) { return { items: write.items.length, evidence: write.evidence.length } }
}

class FakeDreamCursor implements DreamCursorStore {
  constructor(public lastEnd: number | null, private readonly interval = 60) {}
  async getLastWindowEnd() { return this.lastEnd }
  async setLastWindowEnd(ms: number) { this.lastEnd = ms }
  async getIntervalMinutes() { return this.interval }
}

class FakeDreamModel implements DreamModel {
  calls = 0;
  async dream(): Promise<string> {
    this.calls++;
    return '{"items":[]}';
  }
}

function episode(id: string, text: string, overrides: Partial<SweepEpisode> = {}): SweepEpisode {
  return {
    id,
    ts: NOW,
    conversation_id: 'thread_sweeper',
    source: 'software',
    sentiment: 'neutral',
    text,
    keys: ['sulla-desktop'],
    checkin_key: null,
    superseded_by: null,
    hasEvidence: false,
    ...overrides,
  };
}

function checkinEpisodes(count: number, jobId: string): SweepEpisode[] {
  return Array.from({ length: count }, (_, index) => episode(
    `checkin-${ index }`,
    `Worker progress update for ${ jobId }: still working on the memory cleanup.`,
    { ts: NOW + index },
  ));
}

function sweeper(store: FakeSweepStore, cursor = new FakeSweepCursor(), logs: string[] = []): DreamDuplicateSweeper {
  let run = 0;
  return new DreamDuplicateSweeper(store, cursor, {
    now: () => NOW,
    runId: () => `fixture-run-${ ++run }`,
    log: line => logs.push(line),
  });
}

describe('DreamDuplicateSweeper', () => {
  it('keeps the newest of 20 same-job check-ins and supersedes the other 19', async() => {
    // risk: stale status floods recall and hides the latest job state
    const store = new FakeSweepStore(checkinEpisodes(20, JOB_A));

    await sweeper(store).sweep();

    expect(store.calls).toHaveLength(19);
    expect(new Set(store.calls.map(call => call.keepId))).toEqual(new Set(['checkin-19']));
    expect(store.episodes.find(row => row.id === 'checkin-19')?.superseded_by).toBeNull();
    expect(store.episodes.filter(row => row.superseded_by === 'checkin-19')).toHaveLength(19);
  });

  it('never supersedes or targets a DECIDED or quoted-human check-in', async() => {
    // risk: human decisions are durable memory and must not be hidden by cleanup
    const decided = episode('decided', `DECIDED: one check-in for ${ JOB_A }; worker progress update.`, { ts: NOW + 2 });
    const quote = episode('quoted', `The user said: “keep the old record”; worker progress update for ${ JOB_B }.`, { ts: NOW + 2 });
    const store = new FakeSweepStore([
      episode('decided-old', `Worker progress update for ${ JOB_A }: still active.`, { ts: NOW }),
      decided,
      episode('quoted-old', `Worker progress update for ${ JOB_B }: still active.`, { ts: NOW }),
      quote,
    ]);

    await sweeper(store).sweep();

    expect(store.calls).toHaveLength(0);
    expect(decided.superseded_by).toBeNull();
    expect(quote.superseded_by).toBeNull();
  });

  it('does not cross-supersede identical status templates from different job identities', async() => {
    // risk: one agent job's status is incorrectly used as another job's latest state
    const template = 'Worker progress update: the work is still active.';
    const first = episode(JOB_A, template, { keys: ['agent-ops'], ts: NOW });
    const second = episode(JOB_B, template, { keys: ['desktop'], ts: NOW + 1 });
    const store = new FakeSweepStore([first, second]);

    await sweeper(store).sweep();

    expect(store.calls).toHaveLength(0);
    expect(first.superseded_by).toBeNull();
    expect(second.superseded_by).toBeNull();
  });

  it('never supersedes or targets user-source and evidence-backed episodes', async() => {
    // risk: human-authored or cited history is lost while duplicate check-ins are cleaned
    const user = episode('user-checkin', `Worker progress update for ${ JOB_A }: status.`, { source: 'user', ts: NOW + 3 });
    const evidenced = episode('evidence-checkin', `Worker progress update for ${ JOB_B }: status.`, { hasEvidence: true, ts: NOW + 3 });
    const store = new FakeSweepStore([
      user,
      episode('a-old', user.text, { ts: NOW }),
      episode('a-new', user.text, { ts: NOW + 1 }),
      evidenced,
      episode('b-old', evidenced.text, { ts: NOW }),
      episode('b-new', evidenced.text, { ts: NOW + 1 }),
    ]);

    await sweeper(store).sweep();

    expect(user.superseded_by).toBeNull();
    expect(evidenced.superseded_by).toBeNull();
    expect(store.calls.some(call => call.oldId === user.id || call.keepId === user.id)).toBe(false);
    expect(store.calls.some(call => call.oldId === evidenced.id || call.keepId === evidenced.id)).toBe(false);
    expect(store.calls.map(call => call.keepId)).toEqual(['a-new', 'b-new']);
  });

  it('keeps exact cross-subject duplicates under the deepest subject, even when older', async() => {
    // risk: duplicated memories dilute the specific subject page and the broader copy wins by recency
    const general = episode('general-newer', 'Release notes, should include the memory dedupe fix!', { keys: ['desktop'], ts: NOW + 1 });
    const specific = episode('specific-older', 'release notes should include the memory dedupe fix', { keys: ['dreamer'], ts: NOW });
    const subjects: SweepSubject[] = [
      { slug: 'global', parent: null, kind: 'global' },
      { slug: 'desktop', parent: 'global', kind: 'major' },
      { slug: 'sulla-desktop', parent: 'desktop', kind: 'project' },
      { slug: 'dreamer', parent: 'sulla-desktop', kind: 'system' },
    ];
    const store = new FakeSweepStore([general, specific], subjects);

    await sweeper(store).sweep();

    expect(store.calls).toEqual([expect.objectContaining({ oldId: 'general-newer', keepId: 'specific-older' })]);
    expect(specific.superseded_by).toBeNull();
    expect(general.superseded_by).toBe('specific-older');
    expect(store.subjectLoads).toBe(1);
  });

  it('is idempotent when run a second time', async() => {
    // risk: recurring Dreamer runs keep appending duplicate supersede mutations
    const store = new FakeSweepStore(checkinEpisodes(20, JOB_A));
    const subject = sweeper(store);

    await subject.sweep();
    const firstRunWrites = store.calls.length;
    await subject.sweep();

    expect(firstRunWrites).toBe(19);
    expect(store.calls).toHaveLength(firstRunWrites);
  });

  it('never overwrites a pre-existing superseded_by link', async() => {
    // risk: historical supersede lineage is corrupted by a later sweeper run
    const alreadySuperseded = episode('already-superseded', `Worker progress update for ${ JOB_A }: stale.`, { superseded_by: 'previous-keeper' });
    const store = new FakeSweepStore([
      alreadySuperseded,
      episode('active-old', `Worker progress update for ${ JOB_A }: stale.`, { ts: NOW }),
      episode('active-new', `Worker progress update for ${ JOB_A }: current.`, { ts: NOW + 1 }),
    ]);

    await sweeper(store).sweep();

    expect(alreadySuperseded.superseded_by).toBe('previous-keeper');
    expect(store.calls.some(call => call.oldId === alreadySuperseded.id)).toBe(false);
  });

  it('walks older episodes in bounded pages with a persisted backward cursor', async() => {
    // risk: old duplicate history is never cleaned or a sweep reads an unbounded backlog
    const episodes = Array.from({ length: MAX_SWEEP_EPISODES + 1 }, (_, index) => episode(
      `unique-${ index + 1 }`,
      `Unique archived memory fact ${ index + 1 }.`,
      { ts: index + 1 },
    ));
    const store = new FakeSweepStore(episodes);
    const cursor = new FakeSweepCursor();
    const subject = sweeper(store, cursor);

    await subject.sweep();
    expect(store.queries).toEqual([{ limit: MAX_SWEEP_EPISODES, beforeTs: undefined }]);
    expect(cursor.beforeTs).toBe(2);

    await subject.sweep();
    expect(store.queries.slice(1)).toEqual([
      { limit: MAX_SWEEP_EPISODES, beforeTs: undefined },
      { limit: MAX_SWEEP_EPISODES, beforeTs: 2 },
    ]);
    expect(cursor.beforeTs).toBeNull();
  });

  it('has no item reads or writes in the sweeper store surface', () => {
    // risk: duplicate cleanup accidentally reaches conclusions or durable DO/DONT rules
    const store: DuplicateSweepStore = new FakeSweepStore([]);

    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store))).toEqual(expect.arrayContaining([
      'loadSweepEpisodes', 'loadSubjects', 'supersedeEpisode',
    ]));
    expect('loadItems' in store).toBe(false);
    expect('supersedeItem' in store).toBe(false);
  });

  it('continues dreaming when the duplicate sweeper throws', async() => {
    // risk: a cleanup-store failure takes the scheduled memory consolidation agent offline
    const batch: DreamBatch = {
      episodes: [{ id: 'dream-episode', ts: NOW - 1_000, source: 'software', text: 'A synthetic memory fact.', keys: ['sulla'], sentiment: 'neutral' }],
      items: [],
    };
    const cursor = new FakeDreamCursor(NOW - 60 * 60 * 1_000);
    const model = new FakeDreamModel();
    const dreamer = new V7Dreamer({
      store: new FakeDreamStore(batch),
      cursor,
      model,
      now: () => NOW,
      sweeper: { sweep: async() => { throw new Error('synthetic storage failure'); } },
    });

    const result = await dreamer.run();

    expect(result.outcome).toBe('dreamed');
    expect(model.calls).toBe(1);
    expect(cursor.lastEnd).toBe(NOW);
  });
});
