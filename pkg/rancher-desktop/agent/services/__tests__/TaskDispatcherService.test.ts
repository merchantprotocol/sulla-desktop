import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const settingsGetMock: any = jest.fn();
const recoverStaleMock: any = jest.fn(() => Promise.resolve([]));
const countRunningMock: any = jest.fn(() => Promise.resolve(0));
const claimNextMock: any = jest.fn(() => Promise.resolve(null));
const claimNextReviewMock: any = jest.fn(() => Promise.resolve(null));
const settleMock: any = jest.fn(() => Promise.resolve());
const finalizeVerificationMock: any = jest.fn(() => Promise.resolve('APPROVE'));
const finalizeProtectedReviewMock: any = jest.fn(() => Promise.resolve('PASS'));
const recordReviewLaunchMock: any = jest.fn(() => Promise.resolve());
const failVerificationMock: any = jest.fn(() => Promise.resolve(true));
const touchMock: any = jest.fn(() => Promise.resolve());
const addCommentMock: any = jest.fn(() => Promise.resolve());
const updateTaskMock: any = jest.fn(() => Promise.resolve());
const executeMock: any = jest.fn();
const graphDeleteMock: any = jest.fn();
const resolvePullRequestHeadMock: any = jest.fn();
const workflowFindByIdMock: any = jest.fn(() => Promise.resolve({ attributesSnapshot: { enabled: true } }));

jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: settingsGetMock },
}));
jest.unstable_mockModule('../../database/models/WorkTaskDispatchModel', () => ({
  WorkTaskDispatchModel: {
    recoverStale:            recoverStaleMock,
    countRunning:            countRunningMock,
    claimNext:               claimNextMock,
    claimNextReview:         claimNextReviewMock,
    settle:                  settleMock,
    finalizeVerification:    finalizeVerificationMock,
    finalizeProtectedReview: finalizeProtectedReviewMock,
    recordReviewLaunch:      recordReviewLaunchMock,
    failVerification:        failVerificationMock,
    touch:                   touchMock,
  },
}));
jest.unstable_mockModule('../../database/models/WorkflowModel', () => ({
  WorkflowModel: { findById: workflowFindByIdMock },
}));
jest.unstable_mockModule('../../database/models/WorkflowExecutionModel', () => ({
  WorkflowExecutionModel: { markRunning: jest.fn(() => Promise.resolve()) },
}));
jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel: {
    addComment:   addCommentMock,
    updateTask:   updateTaskMock,
    listComments: jest.fn(() => Promise.resolve([{ author: 'worker', body: 'Draft PR #123 at head.' }])),
  },
}));
jest.unstable_mockModule('../GraphRegistry', () => ({
  GraphRegistry: {
    getOrCreateAgentGraph: jest.fn(() => Promise.resolve({
      graph: { execute: executeMock },
      state: { messages: [], metadata: {} },
    })),
    delete: graphDeleteMock,
  },
}));
jest.unstable_mockModule('../HeartbeatService', () => ({
  isInsideWindow: jest.fn(() => true),
}));
jest.unstable_mockModule('../GitHubPullRequestHeadService', () => ({
  resolvePullRequestHead: resolvePullRequestHeadMock,
}));
jest.unstable_mockModule('../../utils/sullaPaths', () => ({
  findAgentDir: jest.fn(() => '/agents/opus-worker'),
}));
jest.unstable_mockModule('../../tools/registry', () => ({
  toolRegistry: {
    convertToolToLLM: jest.fn((name: string) => Promise.resolve({
      type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } },
    })),
  },
}));

describe('TaskDispatcherService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recoverStaleMock.mockResolvedValue([]);
    countRunningMock.mockResolvedValue(0);
    claimNextMock.mockResolvedValue(null);
    claimNextReviewMock.mockResolvedValue(null);
    resolvePullRequestHeadMock.mockResolvedValue({
      owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 123, sha: 'a'.repeat(40),
    });
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled') return Promise.resolve(true);
      if (key === 'taskVerifierOwner') return Promise.resolve('legacy');
      return Promise.resolve(fallback);
    });
  });

  it('dark-gates verification by default', async() => {
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    service.destroy();

    expect(claimNextReviewMock).not.toHaveBeenCalled();
  });

  it('recovers orphaned leases before filling worker capacity', async() => {
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();

    await service.initialize();
    service.destroy();

    expect(recoverStaleMock).toHaveBeenCalledWith(0);
    expect(countRunningMock).toHaveBeenCalled();
  });

  it('claims mechanically, executes the assigned worker, and returns completed work for review', async() => {
    const claim = {
      task: {
        id:          'task-1',
        title:       'Ship it',
        description: 'Implement and verify.',
        project_id:  'project-1',
        epic_id:     'epic-1',
        priority:    'high',
      },
      dispatch: {
        id: 'dispatch-1', task_id: 'task-1', agent_id: 'opus-worker', thread_id: 'thread-1',
      },
    };
    claimNextMock
      .mockResolvedValueOnce(claim)
      .mockResolvedValue(null);
    executeMock.mockResolvedValue({
      metadata: { agent: { status: 'completed' }, finalSummary: 'Draft PR opened and tests passed.' },
      messages: [],
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();

    await new Promise(resolve => setTimeout(resolve, 0));
    service.destroy();

    expect(claimNextMock).toHaveBeenCalledWith('opus-worker');
    expect(executeMock).toHaveBeenCalled();
    expect(settleMock).toHaveBeenCalledWith(
      'dispatch-1', 'completed', 'Draft PR opened and tests passed.', undefined,
    );
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', {
      status: 'in_review', assignee: 'heartbeat', actor: 'dispatcher',
    });
  });

  it('starts three independent review leases in one pass and settles exact-head approvals', async() => {
    const claims = [1, 2, 3].map(i => ({
      task: {
        id:           `task-${ i }`,
        title:        `Review ${ i }`,
        description:  'Acceptance criteria.',
        project_id:   'project-1',
        epic_id:      'epic-1',
        priority:     'high',
        github_issue: null,
      },
      dispatch: {
        id:        `verify-${ i }`,
        task_id:   `task-${ i }`,
        agent_id:  'codex-test',
        thread_id: `verify-thread-${ i }`,
        kind:      'verification',
        attempt:   1,
      },
    }));
    claimNextReviewMock
      .mockResolvedValueOnce(claims[0])
      .mockResolvedValueOnce(claims[1])
      .mockResolvedValueOnce(claims[2])
      .mockResolvedValue(null);
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled' || key === 'taskVerifierEnabled') return Promise.resolve(true);
      if (key === 'taskVerifierOwner') return Promise.resolve('legacy');
      return Promise.resolve(fallback);
    });
    executeMock.mockResolvedValue({
      metadata: {
        agent:        { status: 'completed' },
        finalSummary: `<VERIFIER_RESULT>{"verdict":"APPROVE","artifact_sha":"${ 'a'.repeat(40) }","summary":"All criteria and focused tests passed."}</VERIFIER_RESULT>`,
      },
      messages: [],
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    await new Promise(resolve => setTimeout(resolve, 10));
    service.destroy();

    expect(claimNextReviewMock).toHaveBeenCalledTimes(4);
    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(finalizeVerificationMock).toHaveBeenCalledTimes(3);
    expect(finalizeVerificationMock).toHaveBeenCalledWith(
      'verify-1', 'APPROVE', 'a'.repeat(40), 'a'.repeat(40), 'All criteria and focused tests passed.',
    );
    expect(resolvePullRequestHeadMock).toHaveBeenCalledTimes(3);
    const verifierState = executeMock.mock.calls[0][0];
    expect(verifierState.metadata.allowedToolNames).toContain('git_diff');
    expect(verifierState.metadata.allowedToolNames).not.toContain('exec');
    expect(verifierState.metadata.allowedToolNames).not.toContain('git_commit');
    expect(verifierState.metadata.allowedToolNames).not.toContain('git_push');
    expect(verifierState.metadata.allowedToolNames).not.toContain('github_merge_pr');
    expect(verifierState.metadata.verifierReadOnly).toBe(true);
    expect(verifierState.messages[0].content).toContain('Re-check the remote head immediately before your verdict');
    expect(verifierState.messages[0].content).toContain('matching local worktree');
  });

  it('invalidates approval when the live PR head changed after review', async() => {
    claimNextReviewMock
      .mockResolvedValueOnce({
        task: {
          id:           'task-5',
          title:        'Review',
          description:  '',
          project_id:   'p',
          epic_id:      'e',
          priority:     'p0',
          github_issue: 'merchantprotocol/sulla-desktop#660',
        },
        dispatch: {
          id:        'verify-5',
          task_id:   'task-5',
          agent_id:  'codex-test',
          thread_id: 'v5',
          kind:      'verification',
          attempt:   1,
        },
      })
      .mockResolvedValue(null);
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled' || key === 'taskVerifierEnabled') return Promise.resolve(true);
      if (key === 'taskVerifierOwner') return Promise.resolve('legacy');
      return Promise.resolve(fallback);
    });
    resolvePullRequestHeadMock.mockResolvedValue({
      owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 665, sha: 'c'.repeat(40),
    });
    executeMock.mockResolvedValue({
      metadata: {
        agent:        { status: 'completed' },
        finalSummary: `<VERIFIER_RESULT>{"verdict":"APPROVE","artifact_sha":"${ 'b'.repeat(40) }","summary":"Reviewed old head."}</VERIFIER_RESULT>`,
      },
      messages: [],
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    await new Promise(resolve => setTimeout(resolve, 10));
    service.destroy();

    expect(failVerificationMock).toHaveBeenCalledWith(
      'verify-5', `artifact_head_changed:${ 'b'.repeat(40) }:${ 'c'.repeat(40) }`,
    );
    expect(finalizeVerificationMock).not.toHaveBeenCalled();
  });

  it('runs the locked review council, excludes the execution worker, and settles one synthesized verdict', async() => {
    const hash = 'd'.repeat(40);
    claimNextReviewMock
      .mockResolvedValueOnce({
        task: {
          id:           'task-core',
          title:        'Core review',
          description:  'Verify all criteria.',
          project_id:   'p',
          epic_id:      'e',
          priority:     'critical',
          github_issue: 'merchantprotocol/sulla-desktop#669',
        },
        dispatch: {
          id:              'verify-core',
          task_id:         'task-core',
          agent_id:        'codex-test',
          thread_id:       'core-thread',
          kind:            'verification',
          attempt:         1,
          origin_agent_id: 'technical-architect',
        },
      })
      .mockResolvedValue(null);
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled' || key === 'taskVerifierEnabled') return Promise.resolve(true);
      if (key === 'taskVerifierOwner') return Promise.resolve('core-routine');
      return Promise.resolve(fallback);
    });
    resolvePullRequestHeadMock.mockResolvedValue({
      owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 671, sha: hash,
    });
    executeMock.mockResolvedValue({
      metadata: {
        agent:                 { status: 'completed' },
        finalSummary:          'Routine complete.',
        lastCompletedWorkflow: {
          workflowId:  'core-routine-review-project-artifact',
          executionId: 'wfp-review-1',
          outcome:     'completed',
          nodeResults: [{
            nodeId: 'node-review-synthesize',
            result: JSON.stringify({
              disposition:  'PASS',
              artifactType: 'code_pr',
              artifactRef:  hash,
              artifactUrl:  'https://github.com/merchantprotocol/sulla-desktop/pull/671',
              artifactHash: hash,
              summary:      'All criteria proved.',
              checks:       ['tests'],
              findings:     [],
              wait:         null,
            }),
          }],
        },
      },
      messages: [],
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    await new Promise(resolve => setTimeout(resolve, 10));
    service.destroy();

    expect(recordReviewLaunchMock).toHaveBeenCalledWith(
      'verify-core', expect.stringMatching(/^wfp-/), ['code-researcher', 'thinking-worker'],
    );
    const state = executeMock.mock.calls[0][0];
    expect(state.metadata.activeWorkflow.definition.nodes.some(
      (node: any) => node.data?.config?.agentId === 'technical-architect',
    )).toBe(false);
    expect(state.metadata.verifierReadOnly).toBe(true);
    expect(finalizeProtectedReviewMock).toHaveBeenCalledWith(
      'verify-core', 'PASS', expect.objectContaining({
        workflowExecutionId: 'wfp-review-1',
        reviewerAgentIds:    ['code-researcher', 'thinking-worker'],
        artifactHash:        hash,
      }), hash,
    );
  });

  it.each(['APPROVE', 'REWORK', 'BLOCKED'] as const)('strictly parses %s with a full exact head', async(verdict) => {
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService() as any;
    expect(service.parseVerification(
      `<VERIFIER_RESULT>{"verdict":"${ verdict }","artifact_sha":"${ 'b'.repeat(40) }","summary":"Evidence."}</VERIFIER_RESULT>`,
    )).toEqual({ verdict, artifactSha: 'b'.repeat(40), summary: 'Evidence.' });
    expect(service.parseVerification(
      `<VERIFIER_RESULT>{"verdict":"${ verdict }","artifact_sha":"deadbeef","summary":"Evidence."}</VERIFIER_RESULT>`,
    )).toBeNull();
  });

  it('rejects malformed verifier output without changing the task to blocked', async() => {
    claimNextReviewMock
      .mockResolvedValueOnce({
        task:     { id: 'task-4', title: 'Review', description: '', project_id: 'p', epic_id: 'e', priority: 'p0' },
        dispatch: { id: 'verify-4', task_id: 'task-4', agent_id: 'codex-test', thread_id: 'v4', kind: 'verification', attempt: 1 },
      })
      .mockResolvedValue(null);
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled' || key === 'taskVerifierEnabled') return Promise.resolve(true);
      if (key === 'taskVerifierOwner') return Promise.resolve('legacy');
      return Promise.resolve(fallback);
    });
    executeMock.mockResolvedValue({ metadata: { agent: { status: 'completed' }, finalSummary: 'APPROVE maybe' }, messages: [] });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    await new Promise(resolve => setTimeout(resolve, 10));
    service.destroy();

    expect(failVerificationMock).toHaveBeenCalledWith('verify-4', 'malformed_verifier_output');
    expect(finalizeVerificationMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalledWith('task-4', expect.objectContaining({ status: 'blocked' }));
  });
});
