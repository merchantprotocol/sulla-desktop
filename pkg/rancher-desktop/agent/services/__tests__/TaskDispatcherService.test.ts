import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const settingsGetMock: any = jest.fn();
const recoverStaleMock: any = jest.fn(() => Promise.resolve([]));
const findRecoverableInProgressMock: any = jest.fn(() => Promise.resolve([]));
const recoverOrphanedInProgressMock: any = jest.fn(() => Promise.resolve([]));
const countRunningMock: any = jest.fn(() => Promise.resolve(0));
const claimNextMock: any = jest.fn(() => Promise.resolve(null));
const claimNextReviewMock: any = jest.fn(() => Promise.resolve(null));
const settleMock: any = jest.fn(() => Promise.resolve());
const finalizeVerificationMock: any = jest.fn(() => Promise.resolve('APPROVE'));
const failVerificationMock: any = jest.fn(() => Promise.resolve(true));
const finalizeMock: any = jest.fn();
const touchMock: any = jest.fn(() => Promise.resolve());
const recordEvidenceMock: any = jest.fn(() => Promise.resolve());
const addCommentMock: any = jest.fn(() => Promise.resolve());
const updateTaskMock: any = jest.fn(() => Promise.resolve());
const planningTransitionMock: any = jest.fn(() => Promise.resolve());
const canonicalVerifyMock: any = jest.fn();
const executeMock: any = jest.fn();
const graphDeleteMock: any = jest.fn();
const resolvePullRequestHeadMock: any = jest.fn();
const workflowFindByIdMock: any = jest.fn(() => Promise.resolve({ attributes: { enabled: true } }));

jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: settingsGetMock },
}));
jest.unstable_mockModule('../../database/models/WorkTaskDispatchModel', () => ({
  WorkTaskDispatchModel: {
    recoverStale: recoverStaleMock,
    findRecoverableInProgress: findRecoverableInProgressMock,
    recoverOrphanedInProgress: recoverOrphanedInProgressMock,
    countRunning: countRunningMock,
    claimNext:    claimNextMock,
    claimNextReview: claimNextReviewMock,
    settle:       settleMock,
    finalizeVerification: finalizeVerificationMock,
    failVerification: failVerificationMock,
    touch:        touchMock,
    finalize:       finalizeMock,
    recordEvidence: recordEvidenceMock,
  },
}));
jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel: {
    addComment: addCommentMock,
    updateTask: updateTaskMock,
    listComments: jest.fn(() => Promise.resolve([{ author: 'worker', body: 'Draft PR #123 at head.' }])),
  },
}));
jest.unstable_mockModule('../PlanningCouncilService', () => ({
  PlanningCouncilService: { handleTaskStatusTransition: planningTransitionMock },
}));
jest.unstable_mockModule('../CanonicalArtifactCustodyService', () => ({
  CanonicalArtifactCustodyService: { verify: canonicalVerifyMock },
}));
jest.unstable_mockModule('../../database/models/WorkflowModel', () => ({
  WorkflowModel: { findById: workflowFindByIdMock },
}));
jest.unstable_mockModule('../../database/models/WorkflowExecutionModel', () => ({
  WorkflowExecutionModel: { markRunning: jest.fn(() => Promise.resolve()) },
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
    findRecoverableInProgressMock.mockResolvedValue([]);
    recoverOrphanedInProgressMock.mockResolvedValue([]);
    countRunningMock.mockResolvedValue(0);
    claimNextMock.mockResolvedValue(null);
    claimNextReviewMock.mockResolvedValue(null);
    resolvePullRequestHeadMock.mockResolvedValue({
      owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 123, sha: 'a'.repeat(40),
    });
    finalizeMock.mockImplementation((_dispatchId: string, taskId: string, finalization: any) => Promise.resolve({
      id:         taskId,
      project_id: 'project-1',
      epic_id:    'epic-1',
      title:      'Task',
      priority:   'high',
      status:     finalization.taskStatus,
      assignee:   finalization.taskAssignee,
    }));
    workflowFindByIdMock.mockResolvedValue({ attributes: { enabled: true } });
    canonicalVerifyMock.mockResolvedValue({
      valid:             true,
      artifactLocation: 'o/r',
      artifactUrl:      'https://github.com/o/r/pull/1',
      artifactRef:      'feature/x',
      contentHash:      '1234567890123456789012345678901234567890',
    });
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled') return Promise.resolve(true);
      if (key === 'taskDispatcherExecutionOwner') return Promise.resolve('core-routine');
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

  it('reports in-progress candidates without mutating while rollout is disabled', async() => {
    findRecoverableInProgressMock.mockResolvedValue([{ task: { id: 'task-1' }, exclusionReasons: [] }]);
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();

    await service.initialize();
    service.destroy();

    expect(findRecoverableInProgressMock).toHaveBeenCalledWith(360, 100);
    expect(recoverOrphanedInProgressMock).not.toHaveBeenCalled();
  });

  it('recovers before normal refill when explicitly enabled and honors the batch and retry caps', async() => {
    const candidate = { task: { id: 'task-1', github_issue: null }, exclusionReasons: [] };
    findRecoverableInProgressMock.mockResolvedValue([candidate]);
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled' || key === 'taskDispatcherInProgressRecoveryEnabled') return Promise.resolve(true);
      if (key === 'taskDispatcherRecoveryBatchSize') return Promise.resolve(2);
      if (key === 'taskDispatcherRecoveryRetryCeiling') return Promise.resolve(4);
      return Promise.resolve(fallback);
    });
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();

    await service.initialize();
    service.destroy();

    expect(recoverOrphanedInProgressMock).toHaveBeenCalledWith([candidate], 2, 4);
    expect(recoverOrphanedInProgressMock.mock.invocationCallOrder[0])
      .toBeLessThan(countRunningMock.mock.invocationCallOrder[0]);
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
      metadata: {
        agent:          { status: 'completed' },
        finalSummary:   'Draft PR opened and tests passed.',
        activeWorkflow: {
          executionId: 'wfp-1',
          nodeOutputs: {
            'node-todo-classify': { result: '{"workType":"coding/repository","selectedAgents":[{"agentId":"opus-worker"}]}' },
            'node-todo-workers':  { result: '{"childIds":["child-1"]}' },
            'node-todo-review':   { result: '{"verdict":"pass","evidence":["inspected remote PR"]}' },
            'node-todo-repair':   { result: '{"route":"pass"}' },
            'node-todo-custody':  { result: '{"verdict":"pass","artifactType":"code","artifactUrl":"https://github.com/o/r/pull/1","artifactRef":"feature/x","headSha":"1234567890123456789012345678901234567890","contentHash":"1234567890123456789012345678901234567890","verificationEvidence":["tests passed"],"reviewerVerdict":"pass"}' },
            'node-todo-record':   { result: '{"taskId":"task-1","proposedComment":"Verified remote draft PR and tests.","nextState":"in_review"}' },
          },
        },
      },
      messages: [],
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();

    await new Promise(resolve => setTimeout(resolve, 0));
    service.destroy();

    expect(claimNextMock).toHaveBeenCalledWith('opus-worker', 'core-todo');
    expect(executeMock).toHaveBeenCalled();
    expect(finalizeMock).toHaveBeenCalledWith('dispatch-1', 'task-1', expect.objectContaining({
      dispatchStatus: 'completed', taskStatus: 'in_review', taskAssignee: 'heartbeat',
    }));
    expect(canonicalVerifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      expect.objectContaining({ artifactType: 'code' }),
      expect.objectContaining({ taskId: 'task-1', nextState: 'in_review' }),
    );
    expect(addCommentMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('uses the legacy executor only when the explicit fallback owner is configured', async() => {
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled') return Promise.resolve(true);
      if (key === 'taskDispatcherExecutionOwner') return Promise.resolve('legacy');
      return Promise.resolve(fallback);
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    service.destroy();

    expect(claimNextMock).toHaveBeenCalledWith('opus-worker', 'legacy-worker');
  });

  it('ships dark by leaving legacy as the default execution owner', async() => {
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled') return Promise.resolve(true);
      return Promise.resolve(fallback);
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    service.destroy();

    expect(claimNextMock).toHaveBeenCalledWith('opus-worker', 'legacy-worker');
  });

  it('pauses new claims when the locked core routine is disabled', async() => {
    workflowFindByIdMock.mockResolvedValue({ attributes: { enabled: false } });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    service.destroy();

    expect(claimNextMock).not.toHaveBeenCalled();
  });

  it('routes incomplete custody to planning for the #667 recovery routine', async() => {
    const claim = {
      task: {
        id:          'task-2',
        title:       'Ship safely',
        description: 'Needs remote proof.',
        project_id:  'project-1',
        epic_id:     'epic-1',
        priority:    'critical',
      },
      dispatch: {
        id: 'dispatch-2', task_id: 'task-2', agent_id: 'opus-worker', thread_id: 'thread-2',
      },
    };
    claimNextMock.mockResolvedValueOnce(claim).mockResolvedValue(null);
    const finalizationOrder: string[] = [];
    finalizeMock.mockImplementationOnce(() => {
      finalizationOrder.push('atomic-finalize');
      return Promise.resolve({ ...claim.task, status: 'planning', assignee: 'dispatcher' });
    });
    planningTransitionMock.mockImplementationOnce(() => {
      finalizationOrder.push('planning-claim');
      return Promise.resolve();
    });
    executeMock.mockResolvedValue({
      metadata: {
        agent:          { status: 'completed' },
        finalSummary:   'Custody is incomplete.',
        activeWorkflow: {
          executionId: 'wfp-2',
          nodeOutputs: {
            'node-todo-classify': { result: '{"selectedAgents":[{"agentId":"opus-worker"}]}' },
            'node-todo-workers':  { result: '{"childIds":["child-1"]}' },
            'node-todo-review':   { result: '{"verdict":"replan","evidence":["missing PR"]}' },
            'node-todo-repair':   { result: '{"route":"replan"}' },
            'node-todo-custody':  { result: '{"verdict":"replan","terminalReason":"missing remote PR"}' },
          },
        },
      },
      messages: [],
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    await new Promise(resolve => setTimeout(resolve, 0));
    service.destroy();

    expect(finalizeMock).toHaveBeenCalledWith('dispatch-2', 'task-2', expect.objectContaining({
      taskStatus:   'planning',
      taskAssignee: 'dispatcher',
      evidence:     expect.objectContaining({
        reviewerVerdict: 'replan',
        terminalReason:  'missing remote PR',
      }),
    }));
    expect(planningTransitionMock).toHaveBeenCalledTimes(1);
    expect(planningTransitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-2', status: 'planning' }),
      'in_progress',
      'dispatcher',
    );
    expect(finalizationOrder).toEqual(['atomic-finalize', 'planning-claim']);
    expect(addCommentMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('routes a bare completion without custody proof to planning as a failed contract', async() => {
    const claim = {
      task: {
        id: 'task-3', title: 'Unsafe summary', description: '', project_id: 'project-1', epic_id: 'epic-1', priority: 'high',
      },
      dispatch: {
        id: 'dispatch-3', task_id: 'task-3', agent_id: 'opus-worker', thread_id: 'thread-3',
      },
    };
    claimNextMock.mockResolvedValueOnce(claim).mockResolvedValue(null);
    executeMock.mockResolvedValue({
      metadata: { agent: { status: 'completed' }, finalSummary: 'Looks good.' },
      messages: [],
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    await new Promise(resolve => setTimeout(resolve, 0));
    service.destroy();

    expect(finalizeMock).toHaveBeenCalledWith('dispatch-3', 'task-3', expect.objectContaining({
      dispatchStatus: 'failed',
      taskStatus:     'planning',
      error:          'core routine returned without structured acceptance and custody evidence',
    }));
  });

  it('rejects a pass verdict that lacks verifiable remote custody evidence', async() => {
    const claim = {
      task: {
        id: 'task-5', title: 'Prove it', description: '', project_id: 'project-1', epic_id: 'epic-1', priority: 'high',
      },
      dispatch: {
        id: 'dispatch-5', task_id: 'task-5', agent_id: 'opus-worker', thread_id: 'thread-5',
      },
    };
    claimNextMock.mockResolvedValueOnce(claim).mockResolvedValue(null);
    executeMock.mockResolvedValue({
      metadata: {
        agent:          { status: 'completed' },
        finalSummary:   'Pass.',
        activeWorkflow: {
          executionId: 'wfp-5',
          nodeOutputs: {
            'node-todo-classify': { result: '{"workType":"coding/repository"}' },
            'node-todo-review':   { result: '{"verdict":"pass","evidence":["summary only"]}' },
            'node-todo-repair':   { result: '{"route":"pass"}' },
            'node-todo-custody':  { result: '{"verdict":"pass","reviewerVerdict":"pass"}' },
            'node-todo-record':   { result: '{"recorded":true}' },
          },
        },
      },
      messages: [],
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    await new Promise(resolve => setTimeout(resolve, 0));
    service.destroy();

    expect(finalizeMock).toHaveBeenCalledWith('dispatch-5', 'task-5', expect.objectContaining({
      dispatchStatus: 'failed',
      taskStatus:     'planning',
      error:          'structured review or durable artifact custody evidence is incomplete',
    }));
  });

  it('routes internal execution errors to planning instead of blocked', async() => {
    const claim = {
      task: {
        id: 'task-4', title: 'Retry me', description: '', project_id: 'project-1', epic_id: 'epic-1', priority: 'high',
      },
      dispatch: {
        id: 'dispatch-4', task_id: 'task-4', agent_id: 'opus-worker', thread_id: 'thread-4',
      },
    };
    claimNextMock.mockResolvedValueOnce(claim).mockResolvedValue(null);
    executeMock.mockRejectedValue(new Error('worker transport failed'));

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    await new Promise(resolve => setTimeout(resolve, 0));
    service.destroy();

    expect(finalizeMock).toHaveBeenCalledWith('dispatch-4', 'task-4', expect.objectContaining({
      dispatchStatus: 'failed', taskStatus: 'planning', taskAssignee: 'dispatcher',
    }));
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
      return Promise.resolve(fallback);
    });
    executeMock.mockResolvedValue({
      metadata: {
        agent: { status: 'completed' },
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
      return Promise.resolve(fallback);
    });
    resolvePullRequestHeadMock.mockResolvedValue({
      owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 665, sha: 'c'.repeat(40),
    });
    executeMock.mockResolvedValue({
      metadata: {
        agent: { status: 'completed' },
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
        task: { id: 'task-4', title: 'Review', description: '', project_id: 'p', epic_id: 'e', priority: 'p0' },
        dispatch: { id: 'verify-4', task_id: 'task-4', agent_id: 'codex-test', thread_id: 'v4', kind: 'verification', attempt: 1 },
      })
      .mockResolvedValue(null);
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled' || key === 'taskVerifierEnabled') return Promise.resolve(true);
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
