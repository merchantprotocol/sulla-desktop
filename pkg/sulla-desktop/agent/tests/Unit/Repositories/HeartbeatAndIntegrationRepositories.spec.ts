// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { HeartbeatSeenIssueRepository } from '../../../app/Repositories/HeartbeatSeenIssueRepository';
import { IntegrationPackageRepository } from '../../../app/Repositories/IntegrationPackageRepository';

const fakeClient = (rows: unknown[] = []) => ({ query: vi.fn(async() => rows) as any });
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('HeartbeatSeenIssueRepository', () => {
  const claim = { owner: 'acme', repo: 'web', issueNumber: 7, nodeId: null, title: 'Bug', claimMethod: 'assign' };

  // risk: two agents both acting on one issue — a returned row must mean "won".
  it('claim() wins when the insert returns a row and binds params in order', async() => {
    const client = fakeClient([{ repo_owner: 'acme' }]);

    await expect(new HeartbeatSeenIssueRepository(client).claim(claim)).resolves.toBe(true);
    const [sql, params] = client.query.mock.calls[0];
    expect(squash(sql)).toContain('ON CONFLICT (repo_owner, repo_name, issue_number) DO NOTHING RETURNING repo_owner');
    expect(params).toEqual(['acme', 'web', 7, null, 'Bug', 'assign']);
  });

  it('claim() loses when the row already existed (empty result)', async() => {
    await expect(new HeartbeatSeenIssueRepository(fakeClient([])).claim(claim)).resolves.toBe(false);
  });

  // risk: re-triaging already-handled issues.
  it('seenKeys() builds one VALUES anti-join and returns owner/repo#number keys', async() => {
    const client = fakeClient([{ repo_owner: 'acme', repo_name: 'web', issue_number: 2 }]);
    const keys = await new HeartbeatSeenIssueRepository(client).seenKeys([
      { owner: 'acme', repo: 'web', number: 1 },
      { owner: 'acme', repo: 'web', number: 2 },
    ]);

    expect([...keys]).toEqual(['acme/web#2']);
    const [sql, params] = client.query.mock.calls[0];
    expect(squash(sql)).toContain('JOIN (VALUES ($1, $2, $3::int), ($4, $5, $6::int)) AS c(owner, repo, number)');
    expect(params).toEqual(['acme', 'web', 1, 'acme', 'web', 2]);
  });

  it('seenKeys() skips the query for no candidates', async() => {
    const client = fakeClient();

    expect((await new HeartbeatSeenIssueRepository(client).seenKeys([])).size).toBe(0);
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('IntegrationPackageRepository', () => {
  it('listDistinctIds() returns ids as strings', async() => {
    const client = fakeClient([{ id: 'slack' }, { id: 42 }]);

    await expect(new IntegrationPackageRepository(client).listDistinctIds()).resolves.toEqual(['slack', '42']);
    expect(client.query.mock.calls[0][0]).toBe('SELECT DISTINCT id FROM integration_packages ORDER BY id');
  });
});
