import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { CanonicalArtifactCustodyService, type CanonicalArtifactReader } from '../CanonicalArtifactCustodyService';

const sha = '1234567890123456789012345678901234567890';
const origin = { id: 'task-1', project_id: 'project-1', epic_id: 'epic-1', title: 'Implement issue 668', status: 'in_progress', priority: 'critical', assignee: 'dispatcher', github_issue: 'merchantprotocol/sulla-desktop#668' } as any;
const disposition = { taskId: 'task-1', dispatchId: 'dispatch-1', nextState: 'in_review', proposedComment: 'receipt' };
const code = { artifactType: 'code', artifactUrl: 'https://github.com/merchantprotocol/sulla-desktop/pull/670', artifactRef: 'hb/5tEH-core-todo-routine', headSha: sha, contentHash: sha, repository: 'merchantprotocol/sulla-desktop', branch: 'hb/5tEH-core-todo-routine', base: 'main', pullRequestRef: 'merchantprotocol/sulla-desktop#670', pullRequestUrl: 'https://github.com/merchantprotocol/sulla-desktop/pull/670', taskId: 'task-1', dispatchId: 'dispatch-1', validationEvidence: 'jest: 2 suites passed', workerProvenance: 'worker-1' };

function reader(headSha = sha): CanonicalArtifactReader {
  return { getPullRequest: jest.fn(() => Promise.resolve({ htmlUrl: code.pullRequestUrl as string, state: 'open', draft: true, headRef: code.branch as string, baseRef: 'main', headSha, body: 'Closes #668' })), getIssue: jest.fn() as any };
}

describe('CanonicalArtifactCustodyService', () => {
  afterEach(() => { jest.restoreAllMocks(); });
  it('accepts a task- and dispatch-bound code receipt against the live draft PR', async() => {
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue(origin);
    await expect(CanonicalArtifactCustodyService.verify(origin, code, disposition, reader())).resolves.toEqual(expect.objectContaining({ valid: true, contentHash: sha }));
  });
  it('rejects every missing structured code field', async() => {
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue(origin);
    for (const field of ['repository', 'branch', 'base', 'headSha', 'pullRequestRef', 'pullRequestUrl', 'validationEvidence', 'workerProvenance', 'taskId', 'dispatchId']) {
      await expect(CanonicalArtifactCustodyService.verify(origin, { ...code, [field]: '' }, disposition, reader())).resolves.toEqual(expect.objectContaining({ valid: false }));
    }
  });
  it('rejects stale remote heads and comment-only proof', async() => {
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue(origin);
    await expect(CanonicalArtifactCustodyService.verify(origin, code, disposition, reader('a'.repeat(40)))).resolves.toEqual(expect.objectContaining({ valid: false, error: 'asserted head SHA does not match the canonical pull request head' }));
    await expect(CanonicalArtifactCustodyService.verify(origin, { ...code, validationEvidence: '' }, disposition, reader())).resolves.toEqual(expect.objectContaining({ valid: false }));
  });
  it('requires complete non-code custody and binds it to task and dispatch', async() => {
    const projectTask = { ...origin, github_issue: null, updated_at: '2026-08-23T20:30:00.000Z' };
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue(projectTask);
    const custody = { artifactType: 'research', artifactLocation: 'projects:task-1', artifactRef: 'task-1', artifactUrl: 'projects://task-1', contentHash: 'hash-project-1', taskId: 'task-1', dispatchId: 'dispatch-1', validationEvidence: 'research checked', workerProvenance: 'worker-1' };
    await expect(CanonicalArtifactCustodyService.verify(projectTask, custody, disposition, reader())).resolves.toEqual(expect.objectContaining({ valid: true, artifactRef: 'task-1' }));
    await expect(CanonicalArtifactCustodyService.verify(projectTask, { ...custody, artifactRef: 'wrong' }, disposition, reader())).resolves.toEqual(expect.objectContaining({ valid: false }));
    for (const field of ['artifactType', 'artifactLocation', 'artifactRef', 'artifactUrl', 'contentHash', 'taskId', 'dispatchId', 'validationEvidence', 'workerProvenance']) {
      await expect(CanonicalArtifactCustodyService.verify(projectTask, { ...custody, [field]: '' }, disposition, reader())).resolves.toEqual(expect.objectContaining({ valid: false }));
    }
  });
});
