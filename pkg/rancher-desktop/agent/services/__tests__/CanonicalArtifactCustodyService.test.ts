import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { WorkLaneDefinitionModel } from '../../database/models/WorkLaneDefinitionModel';
import {
  CanonicalArtifactCustodyService,
  type CanonicalArtifactReader,
} from '../CanonicalArtifactCustodyService';

const origin = {
  id:           'task-1',
  project_id:   'project-1',
  epic_id:      'epic-1',
  title:        'Implement issue 668',
  status:       'in_progress',
  priority:     'critical',
  assignee:     'dispatcher',
  github_issue: 'merchantprotocol/sulla-desktop#668',
} as any;

describe('CanonicalArtifactCustodyService', () => {
  beforeEach(() => {
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: true, catalogPresent: true, missingRoles: [], degradedReason: null,
    });
    jest.spyOn(WorkLaneDefinitionModel, 'preferredLaneKey').mockResolvedValue('qa-custom');
    jest.spyOn(WorkLaneDefinitionModel, 'semanticRoleForStatus').mockResolvedValue('execution');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('binds code custody to the originating task and the live draft PR head', async() => {
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue(origin);
    const reader: CanonicalArtifactReader = {
      getPullRequest: jest.fn(() => Promise.resolve({
        htmlUrl: 'https://github.com/merchantprotocol/sulla-desktop/pull/670',
        state:   'open',
        draft:   true,
        headRef: 'hb/5tEH-core-todo-routine',
        headSha: '1234567890123456789012345678901234567890',
        body:    'Closes #668',
      })),
      getIssue: jest.fn() as any,
    };

    await expect(CanonicalArtifactCustodyService.verify(origin, {
      artifactType:     'code',
      artifactUrl:      'https://github.com/merchantprotocol/sulla-desktop/pull/670',
      artifactRef:      'hb/5tEH-core-todo-routine',
      headSha:          '1234567890123456789012345678901234567890',
      contentHash:      '1234567890123456789012345678901234567890',
    }, {
      taskId:          'task-1',
      nextRole:        'review',
      proposedComment: 'Remote PR and validation verified.',
    }, reader)).resolves.toEqual(expect.objectContaining({
      valid:       true,
      artifactRef: 'hb/5tEH-core-todo-routine',
      contentHash: '1234567890123456789012345678901234567890',
    }));
  });

  it('rejects an asserted PR head that differs from the live canonical head', async() => {
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue(origin);
    const reader: CanonicalArtifactReader = {
      getPullRequest: jest.fn(() => Promise.resolve({
        htmlUrl: 'https://github.com/merchantprotocol/sulla-desktop/pull/670',
        state:   'open',
        draft:   true,
        headRef: 'hb/5tEH-core-todo-routine',
        headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        body:    'Closes #668',
      })),
      getIssue: jest.fn() as any,
    };

    await expect(CanonicalArtifactCustodyService.verify(origin, {
      artifactType: 'code',
      artifactUrl:  'https://github.com/merchantprotocol/sulla-desktop/pull/670',
      artifactRef:  'hb/5tEH-core-todo-routine',
      headSha:      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      contentHash:  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }, {
      taskId: 'task-1', nextRole: 'review', proposedComment: 'Verified.',
    }, reader)).resolves.toEqual(expect.objectContaining({
      valid: false,
      error: 'asserted head SHA does not match the canonical pull request head',
    }));
  });

  it('rejects a disposition for any task other than the originating claim', async() => {
    const reader = { getPullRequest: jest.fn(), getIssue: jest.fn() } as any;
    await expect(CanonicalArtifactCustodyService.verify(origin, {}, {
      taskId: 'task-other', nextRole: 'review', proposedComment: 'Wrong task.',
    }, reader)).resolves.toEqual(expect.objectContaining({
      valid: false,
      error: 'proposed disposition is not bound to the originating task',
    }));
    expect(reader.getPullRequest).not.toHaveBeenCalled();
  });

  it('binds non-code custody to the live originating Projects row', async() => {
    const projectOnlyTask = {
      ...origin,
      github_issue: null,
      updated_at:   '2026-08-23T20:30:00.000Z',
    };
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue(projectOnlyTask);
    const reader = { getPullRequest: jest.fn(), getIssue: jest.fn() } as any;

    await expect(CanonicalArtifactCustodyService.verify(projectOnlyTask, {
      artifactType:     'research',
      artifactLocation: 'projects:task-1',
      artifactRef:      'task-1',
    }, {
      taskId:          'task-1',
      nextRole:        'review',
      proposedComment: 'Research evidence and disposition are ready.',
    }, reader)).resolves.toEqual(expect.objectContaining({
      valid:             true,
      artifactLocation: 'projects:task-1',
      artifactRef:      'task-1',
      contentHash:      '2026-08-23T20:30:00.000Z',
    }));
    expect(reader.getIssue).not.toHaveBeenCalled();
  });
});
