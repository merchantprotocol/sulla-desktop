/** @jest-environment node */
import { describe, expect, it, jest } from '@jest/globals';

import { GitHubPullRequestMirrorService } from '../GitHubPullRequestMirrorService';

const repository = { owner: 'example-org', repo: 'backend-api' };

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number:              42,
    title:               'Fix the thing',
    body:                'Canonical body',
    html_url:            'https://github.com/example-org/backend-api/pull/42',
    state:               'open',
    draft:               false,
    merged:              false,
    mergeable:           true,
    mergeable_state:     'clean',
    updated_at:          '2026-09-02T12:00:00Z',
    user:                { login: 'dev' },
    head:                { sha: 'ABCDEF1234' },
    base:                { sha: '1234ABCDEF' },
    requested_reviewers: [],
    requested_teams:     [],
    ...overrides,
  };
}

function github(pr = pull()) {
  return {
    paginate: jest.fn(() => Promise.resolve([pr])),
    pulls:    {
      list:        jest.fn(),
      get:         jest.fn(() => Promise.resolve({ data: pr })),
      listReviews: jest.fn(() => Promise.resolve({ data: [] })),
    },
    checks: { listForRef: jest.fn(() => Promise.resolve({ data: { check_runs: [] } })) },
  };
}

function projects(tasks: any[] = [], lanes: { lane_key: string; enabled: boolean; archived: boolean }[] = [
  { lane_key: 'backlog', enabled: true, archived: false },
  { lane_key: 'done', enabled: true, archived: false },
]) {
  return {
    ready:                 jest.fn(() => Promise.resolve(undefined)),
    getEpic:               jest.fn(() => Promise.resolve({ id: 'epic', project_id: 'project', archived: false })),
    getTask:               jest.fn(() => Promise.resolve(null)),
    resolveEffectiveLanes: jest.fn(() => Promise.resolve(lanes)),
    listTasks:             jest.fn(() => Promise.resolve(tasks)),
    createTask:            jest.fn((input: any, _context: any) => Promise.resolve({ ...input, id: 'new-task' })),
    updateTask:            jest.fn((_id: string, input: any, _context: any) => Promise.resolve(input)),
    addComment:            jest.fn(() => Promise.resolve(undefined)),
  };
}

function store() {
  return {
    claim:          jest.fn(() => Promise.resolve({})),
    listForScope:   jest.fn(() => Promise.resolve([])),
    recordSnapshot: jest.fn(() => Promise.resolve(undefined)),
    recordError:    jest.fn(() => Promise.resolve(undefined)),
  };
}

const input = {
  repositories:   [repository],
  epicId:         'epic',
  parentId:       null,
  openStatus:     'backlog',
  terminalStatus: 'done',
  actor:          'mirror',
  dryRun:         false,
  batchSize:      100,
};

describe('GitHubPullRequestMirrorService', () => {
  it('creates one child issue with stable identity and full canonical metadata', async() => {
    const gh = github();
    const db = projects();
    const result = await new GitHubPullRequestMirrorService(gh as any, db as any, store() as any).reconcile(input);

    expect(result).toMatchObject({ discovered: 1, created: 1, updated: 0 });
    expect(db.createTask).toHaveBeenCalledTimes(1);
    expect(db.createTask).toHaveBeenCalledWith(expect.objectContaining({
      epic_id:      'epic',
      parent_id:    null,
      source_ref:   'github-pr:example-org/backend-api#42',
      github_issue: 'https://github.com/example-org/backend-api/pull/42',
      title:        'Review PR #42 — Fix the thing',
      status:       'backlog',
    }), { actor: 'mirror', source: 'routine' });
    expect(db.createTask.mock.calls[0][0].description).toContain('Head SHA: abcdef1234');
    expect(db.createTask.mock.calls[0][0].description).toContain('Canonical body');
  });

  it('does not infer installation-specific repository classifications', async() => {
    const db = projects();
    await new GitHubPullRequestMirrorService(github() as any, db as any, store() as any).reconcile(input);

    const created = db.createTask.mock.calls[0][0];
    expect(created.title).toBe('Review PR #42 — Fix the thing');
    expect(created.labels).toEqual(['github-pr-mirror', 'pr-review']);
    expect(created.labels).not.toContain('frontend');
    expect(created.labels).not.toContain('backend');
  });

  it('does not duplicate an unchanged mirrored PR', async() => {
    const pr = pull();
    const firstDb = projects();
    await new GitHubPullRequestMirrorService(github(pr) as any, firstDb as any, store() as any).reconcile(input);
    const description = firstDb.createTask.mock.calls[0][0].description;
    const db = projects([{
      id:           'existing',
      created_at:   '2026-09-01',
      source_ref:   'github-pr:example-org/backend-api#42',
      github_issue: pr.html_url,
      title:        'Review PR #42 — Fix the thing',
      description,
      status:       'in_progress',
      labels:       ['github-pr-mirror', 'pr-review'],
      source:       'github-pr-mirror',
    }]);
    const result = await new GitHubPullRequestMirrorService(github(pr) as any, db as any, store() as any).reconcile(input);

    expect(result.unchanged).toBe(1);
    expect(db.createTask).not.toHaveBeenCalled();
    expect(db.updateTask).not.toHaveBeenCalled();
  });

  it('moves an existing mirror to the matching terminal state and can reopen it', async() => {
    const existing = {
      id:           'existing',
      created_at:   '2026-09-01',
      source_ref:   'github-pr:example-org/backend-api#42',
      github_issue: '',
      title:        '',
      description:  '',
      status:       'in_progress',
      labels:       [],
      source:       '',
    };
    const closedDb = projects([existing]);
    const closed = pull({ state: 'closed', merged: true });
    await new GitHubPullRequestMirrorService(github(closed) as any, closedDb as any, store() as any).reconcile(input);
    expect(closedDb.updateTask).toHaveBeenCalledWith('existing', expect.objectContaining({ status: 'done' }), expect.anything());

    const reopenedDb = projects([{ ...existing, status: 'done' }]);
    await new GitHubPullRequestMirrorService(github() as any, reopenedDb as any, store() as any).reconcile(input);
    expect(reopenedDb.updateTask).toHaveBeenCalledWith('existing', expect.objectContaining({ status: 'backlog' }), expect.anything());
  });

  it('reopens against an arbitrary caller-configured terminal status, not a fixed vocabulary', async() => {
    const customInput = { ...input, openStatus: 'intake', terminalStatus: 'shipped' };
    const lanes = [
      { lane_key: 'intake', enabled: true, archived: false },
      { lane_key: 'shipped', enabled: true, archived: false },
    ];
    const existing = {
      id:           'existing',
      created_at:   '2026-09-01',
      source_ref:   'github-pr:example-org/backend-api#42',
      github_issue: '',
      title:        '',
      description:  '',
      status:       'shipped',
      labels:       [],
      source:       '',
    };
    const db = projects([existing], lanes);
    const result = await new GitHubPullRequestMirrorService(github() as any, db as any, store() as any).reconcile(customInput);

    expect(result.reopened).toBe(1);
    expect(db.updateTask).toHaveBeenCalledWith('existing', expect.objectContaining({ status: 'intake' }), expect.anything());

    const updatedExisting = { ...existing, ...db.updateTask.mock.calls[0][1] };
    const stableExisting = { ...updatedExisting, status: 'cancelled' };
    const stableDb = projects([stableExisting], [
      { lane_key: 'intake', enabled: true, archived: false },
      { lane_key: 'shipped', enabled: true, archived: false },
      { lane_key: 'cancelled', enabled: true, archived: false },
    ]);
    const stableResult = await new GitHubPullRequestMirrorService(github() as any, stableDb as any, store() as any)
      .reconcile({ ...customInput });
    expect(stableResult.reopened).toBe(0);
    expect(stableResult.unchanged).toBe(1);
    expect(stableDb.updateTask).not.toHaveBeenCalled();
  });

  it('reports pre-existing duplicate identities and never creates another', async() => {
    const existing = {
      created_at:   '2026-09-01',
      source_ref:   'github-pr:example-org/backend-api#42',
      github_issue: '',
      title:        '',
      description:  '',
      status:       'backlog',
      labels:       [],
      source:       '',
    };
    const db = projects([{ ...existing, id: 'one' }, { ...existing, id: 'two', created_at: '2026-09-02' }]);
    const result = await new GitHubPullRequestMirrorService(github() as any, db as any, store() as any).reconcile(input);
    expect(result.duplicates).toEqual(['example-org/backend-api#42']);
    expect(db.createTask).not.toHaveBeenCalled();
    expect(db.updateTask).toHaveBeenCalledTimes(1);
  });

  it('reports a concurrent unique-index discovery loss without aborting the batch', async() => {
    const db = projects();
    const concurrentlyCreated = {
      id:           'winner',
      created_at:   '2026-09-02',
      source_ref:   'github-pr:example-org/backend-api#42',
      github_issue: 'https://github.com/example-org/backend-api/pull/42',
      title:        'Review PR #42 — Fix the thing',
      description:  '',
      status:       'backlog',
      labels:       [],
      source:       'github-pr-mirror',
    };
    db.listTasks.mockResolvedValueOnce([] as never).mockResolvedValueOnce([concurrentlyCreated] as never);
    db.createTask.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }) as never);
    const result = await new GitHubPullRequestMirrorService(github() as any, db as any, store() as any).reconcile(input);
    expect(result).toMatchObject({ created: 0, unchanged: 1, processed: 1, failures: [] });
  });

  it('fails closed before remote discovery when the configured stage is absent', async() => {
    const db = projects();
    db.resolveEffectiveLanes.mockResolvedValueOnce([{ lane_key: 'backlog', enabled: true, archived: false }] as never);
    const gh = github();
    await expect(new GitHubPullRequestMirrorService(gh as any, db as any, store() as any).reconcile(input))
      .rejects.toThrow("has no active 'done' stage");
    expect(gh.paginate).not.toHaveBeenCalled();
    expect(db.createTask).not.toHaveBeenCalled();
  });

  it('defaults to preview-safe behavior without writing Projects or the ledger', async() => {
    const db = projects();
    const ledger = store();
    const result = await new GitHubPullRequestMirrorService(github() as any, db as any, ledger as any)
      .reconcile({ ...input, dryRun: true });
    expect(result).toMatchObject({ dryRun: true, created: 1, processed: 1 });
    expect(db.createTask).not.toHaveBeenCalled();
    expect(ledger.claim).not.toHaveBeenCalled();
  });

  it('preserves Projects-owned prose outside the managed GitHub block', async() => {
    const db = projects([{
      id:           'existing',
      created_at:   '2026-09-01',
      source_ref:   'github-pr:example-org/backend-api#42',
      github_issue: '',
      title:        '',
      description:  'Human note that must survive.',
      status:       'in_progress',
      labels:       [],
      source:       '',
    }]);
    await new GitHubPullRequestMirrorService(github() as any, db as any, store() as any).reconcile(input);
    expect(db.updateTask.mock.calls[0][1].description).toContain('Human note that must survive.');
  });
});
