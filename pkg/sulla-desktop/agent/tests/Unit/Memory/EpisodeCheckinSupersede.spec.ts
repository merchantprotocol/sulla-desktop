// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import {
  V7SubjectMemoryWriter,
  type ElephantWrite,
  type V7SubjectMemoryDatabase,
} from '../../../memory/V7SubjectMemoryWriter';

type WriteEpisode = ElephantWrite['episodes'][number];

interface StoredEpisode {
  id: string;
  ts: number;
  keys: string[];
  conversation_id: string | null;
  sentiment: string | null;
  checkin_key: string | null;
  superseded_by: string | null;
  superseded_ts: number | null;
  superseded_reason: string | null;
}

interface SubjectRow {
  slug: string;
  kind: string;
  parent: string | null;
}

interface FakeQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

interface FakeTransactionClient {
  query<Row = unknown>(sql: string, params?: unknown[]): Promise<FakeQueryResult<Row>>;
}

const subjects: SubjectRow[] = [
  { slug: 'global', kind: 'global', parent: null },
  { slug: 'company', kind: 'major', parent: 'global' },
  { slug: 'project', kind: 'project', parent: 'company' },
  { slug: 'alpha', kind: 'domain', parent: 'project' },
  { slug: 'beta', kind: 'domain', parent: 'project' },
];

class FakeSubjectMemoryDatabase {
  readonly episodes: StoredEpisode[];
  readonly statements: Array<{ sql: string; params: unknown[] }> = [];
  transactions = 0;

  constructor(
    initialEpisodes: StoredEpisode[] = [],
    private readonly subjectRows: SubjectRow[] = subjects
  ) {
    this.episodes = initialEpisodes.map(episode => ({ ...episode, keys: [...episode.keys] }));
  }

  async transaction<Result>(callback: (client: FakeTransactionClient) => Promise<Result>): Promise<Result> {
    this.transactions += 1;
    return callback({
      query: async <Row = unknown>(sql: string, params: unknown[] = []): Promise<FakeQueryResult<Row>> => {
        this.statements.push({ sql, params });

        if (sql.includes('SELECT slug, kind, parent FROM subject_memory.subjects')) {
          return { rows: this.subjectRows as unknown as Row[], rowCount: this.subjectRows.length };
        }
        if (sql.includes('INSERT INTO subject_memory.episodes')) {
          const id = String(params[0]);
          if (this.episodes.some(episode => episode.id === id)) return { rows: [], rowCount: 0 };
          this.episodes.push({
            id,
            ts: Number(params[1]),
            conversation_id: params[2] === null ? null : String(params[2]),
            sentiment: params[6] === null ? null : String(params[6]),
            keys: Array.isArray(params[5]) ? params[5].map(String) : [],
            checkin_key: params[8] === null ? null : String(params[8]),
            superseded_by: null,
            superseded_ts: null,
            superseded_reason: null,
          });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('UPDATE subject_memory.episodes')) {
          const [newIdValue, keyValue, tsValue, supersededTsValue, reasonValue] = params;
          const newId = String(newIdValue);
          const key = String(keyValue);
          const ts = Number(tsValue);
          const supersededTs = Number(supersededTsValue);
          const reason = String(reasonValue);
          let rowCount = 0;
          for (const episode of this.episodes) {
            if (
              episode.checkin_key === key &&
              episode.superseded_by === null &&
              episode.id !== newId &&
              episode.ts <= ts
            ) {
              episode.superseded_by = newId;
              episode.superseded_ts = supersededTs;
              episode.superseded_reason = reason;
              rowCount += 1;
            }
          }
          return { rows: [], rowCount };
        }

        return { rows: [], rowCount: 1 };
      },
    });
  }
}

const episode = (
  ts: number,
  suffix: number,
  text: string,
  source = 'observed',
  keys = ['project', 'beta'],
  conversationId: string | null = null,
  sentiment: string | null = null
): WriteEpisode => ({
  id: `${ts}-${source}-${suffix}`,
  ts,
  conversation_id: conversationId,
  source,
  text,
  keys,
  sentiment,
  refs: [],
});

const checkin = (ts: number, suffix: number): WriteEpisode => episode(
  ts,
  suffix,
  'Orchestrator wake-up: agent-job-1795493855725-88 resumed; progress update follows.'
);

const write = (
  episodes: WriteEpisode[],
  evidence: ElephantWrite['evidence'] = []
): ElephantWrite => ({
  episodes,
  items: evidence.length ? [{
    id: '1700000000000-user-1',
    ptype: 'direction',
    text: 'A user-stated memory item.',
    why: null,
    scope: ['project'],
    ts: 1_700_000_000_000,
    supersedes: null,
    always_on: false,
  }] : [],
  evidence,
});

const stored = (
  id: string,
  ts: number,
  checkinKey: string,
  supersededBy: string | null = null
): StoredEpisode => ({
  id, ts, conversation_id: null, sentiment: null, keys: ['project'],
  checkin_key: checkinKey, superseded_by: supersededBy,
  superseded_ts: supersededBy ? ts : null, superseded_reason: supersededBy ? 'legacy' : null,
});

const writerFor = (database: FakeSubjectMemoryDatabase): V7SubjectMemoryWriter =>
  new V7SubjectMemoryWriter(database as unknown as V7SubjectMemoryDatabase);

describe('Episode check-in superseding', () => {
  it('supersedes only older active rows with the same key and processes a batch by timestamp', async () => {
    // risk: stale status check-ins remain recallable or a later item is superseded by an older one
    const key = 'job:agent-job-1795493855725-88';
    const seedTs = 1_700_000_000_000;
    const old = stored(`${seedTs}-observed-1`, seedTs, key);
    const historic = stored(`${seedTs + 1}-observed-2`, seedTs + 1, key, 'already-replaced');
    const future = stored(`${seedTs + 50}-observed-3`, seedTs + 50, key);
    const unrelated = stored(`${seedTs}-observed-4`, seedTs, 'job:agent-job-2-2');
    const database = new FakeSubjectMemoryDatabase([old, historic, future, unrelated]);
    const earlier = checkin(seedTs + 10, 5);
    const later = checkin(seedTs + 20, 6);

    const result = await writerFor(database).append(write([later, earlier]));

    expect(result).toMatchObject({ accepted: true, episodes: 2 });
    expect(database.transactions).toBe(1);
    expect(database.episodes.find(row => row.id === old.id)).toMatchObject({
      superseded_by: earlier.id,
      superseded_ts: earlier.ts,
      superseded_reason: 'newer_checkin',
    });
    expect(database.episodes.find(row => row.id === earlier.id)).toMatchObject({
      superseded_by: later.id,
      superseded_ts: later.ts,
      superseded_reason: 'newer_checkin',
    });
    expect(database.episodes.find(row => row.id === historic.id)?.superseded_by).toBe('already-replaced');
    expect(database.episodes.find(row => row.id === future.id)?.superseded_by).toBeNull();
    expect(database.episodes.find(row => row.id === unrelated.id)?.superseded_by).toBeNull();
    expect(database.episodes.slice(-2).map(row => row.id)).toEqual([earlier.id, later.id]);
  });

  it('leaves non-check-ins and user-source episodes untouched', async () => {
    // risk: ordinary observations or human decisions are incorrectly hidden as superseded status
    const key = 'job:agent-job-1795493855725-88';
    const ts = 1_700_000_000_100;
    const older = stored(`${ts - 1}-observed-1`, ts - 1, key);
    const nonCheckin = episode(ts, 2, 'Design note mentions agent-job-1795493855725-88 without recording activity.');
    const userEpisode = episode(ts + 1, 3, 'Manager status update: agent-job-1795493855725-88 is still active.', 'user');
    const database = new FakeSubjectMemoryDatabase([older]);

    await writerFor(database).append(write([nonCheckin, userEpisode]));

    expect(database.episodes.find(row => row.id === older.id)?.superseded_by).toBeNull();
    expect(database.episodes.find(row => row.id === nonCheckin.id)).toMatchObject({ checkin_key: null, keys: nonCheckin.keys });
    expect(database.episodes.find(row => row.id === userEpisode.id)).toMatchObject({ checkin_key: null, keys: userEpisode.keys });
    expect(database.statements.some(statement => statement.sql.includes('UPDATE subject_memory.episodes'))).toBe(false);
  });

  it('does not key or supersede an episode referenced as evidence in this write', async () => {
    // risk: human evidence is hidden from memory history by status-only deduplication
    const key = 'job:agent-job-1795493855725-88';
    const ts = 1_700_000_000_200;
    const older = stored(`${ts - 1}-observed-1`, ts - 1, key);
    const evidenceEpisode = checkin(ts, 2);
    const database = new FakeSubjectMemoryDatabase([older]);

    await writerFor(database).append(write([evidenceEpisode], [
      { item_id: '1700000000000-user-1', episode_id: evidenceEpisode.id, role: 'origin' },
    ]));

    expect(database.episodes.find(row => row.id === evidenceEpisode.id)?.checkin_key).toBeNull();
    expect(database.episodes.find(row => row.id === evidenceEpisode.id)?.keys).toEqual(evidenceEpisode.keys);
    expect(database.episodes.find(row => row.id === older.id)?.superseded_by).toBeNull();
    expect(database.statements.some(statement => statement.sql.includes('UPDATE subject_memory.episodes'))).toBe(false);
  });

  it('does not supersede any row when the episode insert is a duplicate', async () => {
    // risk: duplicate retries mark legitimate current check-ins as replaced
    const key = 'job:agent-job-1795493855725-88';
    const ts = 1_700_000_000_300;
    const older = stored(`${ts - 1}-observed-1`, ts - 1, key);
    const duplicate = checkin(ts, 2);
    const existingDuplicate = stored(duplicate.id, ts, key);
    const database = new FakeSubjectMemoryDatabase([older, existingDuplicate]);

    const result = await writerFor(database).append(write([duplicate]));

    expect(result).toMatchObject({ accepted: true, episodes: 0 });
    expect(database.episodes.find(row => row.id === older.id)?.superseded_by).toBeNull();
    expect(database.episodes.find(row => row.id === duplicate.id)?.superseded_by).toBeNull();
    expect(database.statements.some(statement => statement.sql.includes('UPDATE subject_memory.episodes'))).toBe(false);
  });

  it('combines conversation identity with PR identity and respects sentiment', async () => {
    // risk: cross-conversation reports collide or human corrections are marked as check-ins
    const ts = 1_700_000_000_350;
    const neutral = episode(
      ts,
      7,
      'PR #2816 status update.',
      'observed',
      ['project', 'beta'],
      'thread_writer_conversation',
      'neutral'
    );
    const correction = episode(
      ts + 1,
      8,
      'PR #2816 status update.',
      'observed',
      ['project', 'beta'],
      'thread_writer_conversation',
      'correction'
    );
    const database = new FakeSubjectMemoryDatabase();

    await writerFor(database).append(write([neutral, correction]));

    expect(database.episodes.find(row => row.id === neutral.id)).toMatchObject({
      conversation_id: 'thread_writer_conversation',
      sentiment: 'neutral',
      checkin_key: 'conv:thread_writer_conversation|pr:2816',
    });
    expect(database.episodes.find(row => row.id === correction.id)).toMatchObject({
      conversation_id: 'thread_writer_conversation',
      sentiment: 'correction',
      checkin_key: null,
      keys: correction.keys,
    });
  });

  it('stores one deepest eligible primary subject and preserves first-listed ties', async () => {
    // risk: duplicate cross-domain status records continue to fan out into broad memory subjects
    const ts = 1_700_000_000_400;
    const checkinEpisode = episode(
      ts,
      2,
      'Heartbeat status update: agent-job-1795493855725-88 resumed.',
      'observed',
      ['global', 'company', 'project', 'beta', 'alpha']
    );
    const database = new FakeSubjectMemoryDatabase();

    await writerFor(database).append(write([checkinEpisode]));

    expect(database.episodes.find(row => row.id === checkinEpisode.id)).toMatchObject({
      checkin_key: 'job:agent-job-1795493855725-88',
      keys: ['beta'],
    });
  });
});
