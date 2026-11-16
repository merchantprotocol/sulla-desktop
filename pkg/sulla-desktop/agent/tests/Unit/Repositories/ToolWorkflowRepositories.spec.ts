// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { FunctionRunRepository } from '../../../app/Repositories/FunctionRunRepository';
import { RoutineReportRepository } from '../../../app/Repositories/RoutineReportRepository';
import { WorkflowLookupRepository } from '../../../app/Repositories/WorkflowLookupRepository';

const fakeClient = (rows: unknown[] = []) => ({
  query:    vi.fn(async() => rows) as any,
  queryAll: vi.fn(async() => rows) as any,
});
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('FunctionRunRepository', () => {
  // risk: data accuracy — run history must keep jsonb inputs/outputs and null optionals.
  it('inserts a function run row', async() => {
    const client = fakeClient();
    const startedAt = new Date('2026-11-16T10:00:00.000Z');
    const completedAt = new Date('2026-11-16T10:00:02.000Z');
    await new FunctionRunRepository(client).insert({ slug: 'f', version: '1', inputs: { a: 1 }, success: false, startedAt }, completedAt);
    const [sql, params] = client.query.mock.calls[0];
    expect(squash(sql)).toBe('INSERT INTO function_runs (slug, version, runtime, inputs, outputs, success, error_stage, error, duration_ms, started_at, completed_at) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11)');
    expect(params).toEqual(['f', '1', null, '{"a":1}', 'null', false, null, null, null, '2026-11-16T10:00:00.000Z', '2026-11-16T10:00:02.000Z']);
  });

  // risk: data accuracy — filter placeholders must line up with params.
  it('builds the filtered runs query with ordered placeholders', async() => {
    const rows = [{ id: 1 }];
    const client = fakeClient(rows);
    const result = await new FunctionRunRepository(client).recent({ slug: 'f', onlyFailures: true, sinceIso: '2026-11-01T00:00:00.000Z', limit: 9 });
    const [sql, params] = client.query.mock.calls[0];
    expect(result).toBe(rows);
    expect(squash(sql)).toBe('SELECT id, slug, version, runtime, inputs, outputs, success, error_stage, error, duration_ms, started_at, completed_at FROM function_runs WHERE slug = $1 AND success = false AND started_at >= $2 ORDER BY started_at DESC LIMIT $3');
    expect(params).toEqual(['f', '2026-11-01T00:00:00.000Z', 9]);
  });

  it('omits the WHERE clause when no filter is given', async() => {
    const client = fakeClient();
    await new FunctionRunRepository(client).recent({ onlyFailures: false, limit: 50 });
    const [sql, params] = client.query.mock.calls[0];
    expect(squash(sql)).toContain('FROM function_runs ORDER BY started_at DESC LIMIT $1');
    expect(params).toEqual([50]);
  });
});

describe('RoutineReportRepository', () => {
  it('reads the digest summary and exceptions views', async() => {
    const client = fakeClient();
    const repo = new RoutineReportRepository(client);
    await repo.digestSummary();
    await repo.exceptions();
    expect(client.query.mock.calls[0]).toEqual(['SELECT * FROM routine_digest_summary']);
    expect(squash(client.query.mock.calls[1][0])).toContain('FROM routine_exceptions ORDER BY (last_run_status = \'failed\') DESC, routine_slug');
  });

  // risk: data accuracy — slug / execution id / limit must bind to $1/$2/$3.
  it('passes run filters and checkpoint id through as params', async() => {
    const client = fakeClient();
    const repo = new RoutineReportRepository(client);
    await repo.runs('daily', null, 3);
    await repo.checkpoints('exec-1');
    expect(squash(client.query.mock.calls[0][0])).toContain('FROM routine_run_history WHERE ($1::text IS NULL OR routine_slug = $1) AND ($2::text IS NULL OR execution_id = $2) ORDER BY started_at DESC LIMIT $3');
    expect(client.query.mock.calls[0][1]).toEqual(['daily', null, 3]);
    expect(squash(client.query.mock.calls[1][0])).toBe('SELECT sequence, node_id, node_label, node_subtype, node_output FROM workflow_checkpoints WHERE execution_id = $1 ORDER BY sequence ASC');
    expect(client.query.mock.calls[1][1]).toEqual(['exec-1']);
  });

  it('passes promotion-candidate threshold and limit', async() => {
    const client = fakeClient();
    await new RoutineReportRepository(client).promotionCandidates(4, 20);
    expect(squash(client.query.mock.calls[0][0])).toContain('FROM routine_promotion_candidates WHERE conversations >= $1 ORDER BY conversations DESC, occurrences DESC LIMIT $2');
    expect(client.query.mock.calls[0][1]).toEqual([4, 20]);
  });
});

describe('WorkflowLookupRepository', () => {
  // risk: wrong workflow targeted — id lookup is exact, name lookup is case-insensitive.
  it('looks workflows up by id or by case-insensitive name', async() => {
    const client = fakeClient();
    const repo = new WorkflowLookupRepository(client);
    await repo.findById('wf-1');
    await repo.findByName('Daily');
    expect(client.queryAll.mock.calls[0]).toEqual(['SELECT id, name, status, enabled, system FROM workflows WHERE id = $1', ['wf-1']]);
    expect(client.queryAll.mock.calls[1]).toEqual(['SELECT id, name, status, enabled, system FROM workflows WHERE LOWER(name) = LOWER($1)', ['Daily']]);
  });
});
