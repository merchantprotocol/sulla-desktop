import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const settingsGetMock: any = jest.fn();
const recoverStaleMock: any = jest.fn(() => Promise.resolve([]));
const recoverOrphanedVerificationMock: any = jest.fn(() => Promise.resolve([]));
const verificationPoolStatsMock: any = jest.fn(() => Promise.resolve({ backlog: 0, active: 0, suppressedDuplicates: 0, failures: 0 }));
const findRecoverableInProgressMock: any = jest.fn(() => Promise.resolve([]));
const recoverOrphanedInProgressMock: any = jest.fn(() => Promise.resolve([]));
const countRunningMock: any = jest.fn(() => Promise.resolve(0));
const countByRoleMock: any = jest.fn(() => Promise.resolve({ execution: 0, verification: 0, planning: 0 }));
const countReviewBacklogMock: any = jest.fn(() => Promise.resolve(0));
const claimNextMock: any = jest.fn(() => Promise.resolve(null));
const claimNextReviewMock: any = jest.fn(() => Promise.resolve(null));
const settleMock: any = jest.fn(() => Promise.resolve());
const finalizeMock: any = jest.fn(() => Promise.resolve());
const finalizeVerificationMock: any = jest.fn(() => Promise.resolve('APPROVE'));
const finalizeProtectedReviewMock: any = jest.fn(() => Promise.resolve('PASS'));
const recordReviewLaunchMock: any = jest.fn(() => Promise.resolve());
const failVerificationMock: any = jest.fn(() => Promise.resolve(true));
const touchMock: any = jest.fn(() => Promise.resolve());
const addCommentMock: any = jest.fn(() => Promise.resolve());
const updateTaskMock: any = jest.fn(() => Promise.resolve());
const executeMock: any = jest.fn();
const graphGetMock: any = jest.fn(() => Promise.resolve({
  graph: { execute: executeMock },
  state: { messages: [], metadata: {} },
}));
const graphDeleteMock: any = jest.fn();
const recoverPreviousRuntimeMock: any = jest.fn(() => Promise.resolve([]));
const reportCapabilityMock: any = jest.fn(() => Promise.resolve({}));
const releaseStageMock: any = jest.fn(() => Promise.resolve());
const resolvePullRequestHeadMock: any = jest.fn();
const resolvePullRequestHeadsMock: any = jest.fn();
const bindReviewGenerationMock: any = jest.fn();
const generationHashMock: any = jest.fn(() => 'f'.repeat(64));
const workflowFindByIdMock: any = jest.fn(() => Promise.resolve({ attributesSnapshot: { enabled: true } }));
const findAgentDirMock: any = jest.fn(() => '/agents/sulla-desktop');
const automationEnabledMock: any = jest.fn(() => Promise.resolve(true));
const resolveLimitMock: any = jest.fn((_scope: string, configured: number) => Promise.resolve(configured));
const withStatementTimeoutMock: any = jest.fn((_timeoutMs: number, callback: () => Promise<unknown>) => callback());

jest.unstable_mockModule('../../database/PostgresClient', () => ({
  postgresClient: { withStatementTimeout: withStatementTimeoutMock },
}));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: settingsGetMock },
}));
jest.unstable_mockModule('../../database/models/LifecycleCapabilityModel', () => ({
  LifecycleCapabilityModel: {
    recoverPreviousRuntime: recoverPreviousRuntimeMock,
    report:                 reportCapabilityMock,
    releaseStage:           releaseStageMock,
  },
}));
jest.unstable_mockModule('../../database/models/WorkTaskDispatchModel', () => ({
  WorkTaskDispatchModel: {
    recoverStale:            recoverStaleMock,
    recoverOrphanedVerification: recoverOrphanedVerificationMock,
    verificationPoolStats:   verificationPoolStatsMock,
    findRecoverableInProgress: findRecoverableInProgressMock,
    recoverOrphanedInProgress: recoverOrphanedInProgressMock,
    countRunning:            countRunningMock,
    countByRole:             countByRoleMock,
    countReviewBacklog:      countReviewBacklogMock,
    claimNext:               claimNextMock,
    claimNextReview:         claimNextReviewMock,
    settle:                  settleMock,
    finalize:                finalizeMock,
    finalizeVerification:    finalizeVerificationMock,
    finalizeProtectedReview: finalizeProtectedReviewMock,
    recordReviewLaunch:      recordReviewLaunchMock,
    bindReviewGeneration:    bindReviewGenerationMock,
    reviewGenerationHash:    generationHashMock,
    reviewFingerprint:       jest.fn(() => 'e'.repeat(64)),
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
    getOrCreateAgentGraph: graphGetMock,
    delete:                graphDeleteMock,
  },
}));
jest.unstable_mockModule('../RoutineConcurrencyPolicy', () => ({
  RoutineConcurrencyPolicy: {
    isEnabled:     automationEnabledMock,
    resolveLimit:  resolveLimitMock,
    reclaimStale:  jest.fn(() => Promise.resolve()),
    acquire:       jest.fn(() => Promise.resolve('slot')),
    release:       jest.fn(() => Promise.resolve()),
    heartbeat:     jest.fn(() => Promise.resolve()),
  },
}));
jest.unstable_mockModule('../GitHubPullRequestHeadService', () => ({
  resolvePullRequestHead:  resolvePullRequestHeadMock,
  resolvePullRequestHeads: resolvePullRequestHeadsMock,
}));
jest.unstable_mockModule('../../tools/registry', () => ({
  toolRegistry: {
    convertToolToLLM: jest.fn((name: string) => Promise.resolve({
      type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } },
    })),
  },
}));
jest.unstable_mockModule('../../utils/sullaPaths', () => ({
  findAgentDir: findAgentDirMock,
}));

describe('TaskDispatcherService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recoverStaleMock.mockResolvedValue([]);
    recoverOrphanedVerificationMock.mockResolvedValue([]);
    verificationPoolStatsMock.mockResolvedValue({ backlog: 0, active: 0, suppressedDuplicates: 0, failures: 0 });
    findRecoverableInProgressMock.mockResolvedValue([]);
    recoverOrphanedInProgressMock.mockResolvedValue([]);
    countRunningMock.mockResolvedValue(0);
    countByRoleMock.mockResolvedValue({ execution: 0, verification: 0, planning: 0 });
    countReviewBacklogMock.mockResolvedValue(0);
    claimNextMock.mockResolvedValue(null);
    claimNextReviewMock.mockResolvedValue(null);
    workflowFindByIdMock.mockResolvedValue({ attributesSnapshot: { enabled: true } });
    findAgentDirMock.mockReturnValue('/agents/sulla-desktop');
    resolvePullRequestHeadMock.mockResolvedValue({
      owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 123, sha: 'a'.repeat(40),
    });
    resolvePullRequestHeadsMock.mockResolvedValue([{
      owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 123, sha: 'a'.repeat(40),
    }]);
    bindReviewGenerationMock.mockResolvedValue({
      generationHash: 'f'.repeat(64), excludedAgentIds: ['technical-architect'], suppressed: false,
    });
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled') return Promise.resolve(true);
      if (key === 'taskVerifierOwner') return Promise.resolve('legacy');
      return Promise.resolve(fallback);
    });
    recoverPreviousRuntimeMock.mockResolvedValue([]);
    reportCapabilityMock.mockResolvedValue({});
    releaseStageMock.mockResolvedValue(undefined);
    automationEnabledMock.mockResolvedValue(true);
    withStatementTimeoutMock.mockImplementation((_timeoutMs: number, callback: () => Promise<unknown>) => callback());
  });

  it('activates verification by default', async() => {
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    service.destroy();

    expect(claimNextReviewMock).toHaveBeenCalled();
    expect(withStatementTimeoutMock).toHaveBeenCalledWith(30_000, expect.any(Function));
  });

  it('releases a wedged tick at its deadline and runs the next scheduled tick', async() => {
    jest.useFakeTimers();
    try {
      settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
        if (key === 'taskDispatcherTickTimeoutMs') return Promise.resolve(1_000);
        if (key === 'taskVerifierOwner') return Promise.resolve('legacy');
        return Promise.resolve(fallback);
      });
      recoverPreviousRuntimeMock
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValue([]);

      const { TaskDispatcherService } = await import('../TaskDispatcherService');
      const service = new TaskDispatcherService();
      const initialized = service.initialize();

      await jest.advanceTimersByTimeAsync(1_000);
      await initialized;
      await jest.advanceTimersByTimeAsync(59_000);

      expect(recoverPreviousRuntimeMock.mock.calls.length).toBeGreaterThan(1);
      expect(countRunningMock).toHaveBeenCalled();
      expect(reportCapabilityMock).toHaveBeenCalledWith(expect.objectContaining({
        key:     'todo-execution',
        details: expect.objectContaining({ tickWedgeCount: 1 }),
      }));
      service.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the scheduler armed when first-pass recovery throws', async() => {
    jest.useFakeTimers();
    try {
      recoverPreviousRuntimeMock
        .mockRejectedValueOnce(new Error('recovery failed'))
        .mockResolvedValue([]);

      const { TaskDispatcherService } = await import('../TaskDispatcherService');
      const service = new TaskDispatcherService();
      await service.initialize();
      await jest.advanceTimersByTimeAsync(60_000);

      expect(recoverPreviousRuntimeMock.mock.calls.length).toBeGreaterThan(1);
      expect(countRunningMock).toHaveBeenCalled();
      service.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reclaims only review tasks whose previous-runtime claims were recovered', async() => {
    recoverPreviousRuntimeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['orphan-review']);
    recoverOrphanedVerificationMock.mockResolvedValue(['orphan-review']);
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    service.destroy();
    expect(recoverOrphanedVerificationMock).toHaveBeenCalledWith(['orphan-review']);
    expect(recoverStaleMock).toHaveBeenCalledWith();
    expect(reportCapabilityMock).toHaveBeenCalledWith(expect.objectContaining({
      key:     'in-review-verification',
      details: expect.objectContaining({ reclaimed: 1 }),
    }));
  });

  it('leaves in_review visible and unclaimed when the protected routine is disabled', async() => {
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled' || key === 'taskVerifierEnabled' || key === 'taskReviewCoreRoutineEnabled') return Promise.resolve(true);
      if (key === 'taskVerifierOwner') return Promise.resolve('core-routine');
      return Promise.resolve(fallback);
    });
    workflowFindByIdMock.mockResolvedValue({ attributesSnapshot: { enabled: false } });
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    service.destroy();
    expect(claimNextReviewMock).not.toHaveBeenCalled();
    expect(claimNextMock).not.toHaveBeenCalled();
    expect(reportCapabilityMock).toHaveBeenCalledWith(expect.objectContaining({
      key: 'in-review-verification', health: 'unavailable', fallbackMode: 'manual_hold',
    }));
  });

  it('does not require an on-disk agent directory for the default core agent', async() => {
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled' || key === 'taskVerifierEnabled' || key === 'taskReviewCoreRoutineEnabled') return Promise.resolve(true);
      if (key === 'taskVerifierOwner') return Promise.resolve('core-routine');
      return Promise.resolve(fallback);
    });
    // The default core routine agent is a product default, not a customizable
    // one -- a missing/deleted override directory must never take down review.
    findAgentDirMock.mockReturnValue(null);
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    service.destroy();
    expect(claimNextReviewMock).toHaveBeenCalled();
    expect(findAgentDirMock).not.toHaveBeenCalled();
    expect(reportCapabilityMock).toHaveBeenCalledWith(expect.objectContaining({
      key: 'in-review-verification', health: 'healthy',
    }));
  });

  it('suppresses an identical terminal generation before graph or workflow side effects', async() => {
    bindReviewGenerationMock.mockResolvedValue({
      generationHash: 'f'.repeat(64), excludedAgentIds: ['opus-worker'], suppressed: true,
    });
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService() as any;
    await service.runClaim({
      task: {
        id:           'task-suppressed',
        title:        'Already reviewed',
        description:  '',
        project_id:   'p',
        epic_id:      'e',
        priority:     'p0',
        github_issue: 'org/repo#1',
      },
      dispatch: {
        id:        'review-suppressed',
        task_id:   'task-suppressed',
        agent_id:  'codex-test',
        thread_id: 'thread-suppressed',
        kind:      'verification',
        attempt:   2,
      },
      stage_claim: { id: 'review-stage-suppressed' },
    }, 'core-routine');
    expect(graphGetMock).not.toHaveBeenCalled();
    expect(recordReviewLaunchMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('recovers orphaned leases before filling worker capacity', async() => {
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();

    await service.initialize();
    service.destroy();

    expect(recoverStaleMock).toHaveBeenCalledWith(0);
    expect(recoverPreviousRuntimeMock).toHaveBeenCalledWith('todo-execution', expect.stringContaining('task-dispatcher-'));
    expect(countRunningMock).toHaveBeenCalled();
  });

  it('drains downstream review before claiming fresh todo work', async() => {
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled' || key === 'taskVerifierEnabled') return Promise.resolve(true);
      if (key === 'taskVerifierOwner') return Promise.resolve('legacy');
      return Promise.resolve(fallback);
    });
    countReviewBacklogMock.mockResolvedValue(2);

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    service.destroy();

    expect(claimNextReviewMock).toHaveBeenCalled();
    expect(countReviewBacklogMock).toHaveBeenCalledTimes(1);
    expect(claimNextMock).not.toHaveBeenCalled();
    expect(claimNextReviewMock.mock.invocationCallOrder[0])
      .toBeLessThan(countReviewBacklogMock.mock.invocationCallOrder[0]);
  });

  it('starts todo work only after the downstream review backlog is empty', async() => {
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled' || key === 'taskVerifierEnabled') return Promise.resolve(true);
      if (key === 'taskVerifierOwner') return Promise.resolve('legacy');
      return Promise.resolve(fallback);
    });
    countReviewBacklogMock.mockResolvedValue(0);

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    service.destroy();

    expect(claimNextReviewMock.mock.invocationCallOrder[0])
      .toBeLessThan(claimNextMock.mock.invocationCallOrder[0]);
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

  it('ignores custom dispatcher profile settings and pins work to sulla-desktop', async() => {
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled') return Promise.resolve(true);
      if (key === 'taskDispatcherAgentId') return Promise.resolve('project-reader');
      return Promise.resolve(fallback);
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    service.destroy();

    expect(claimNextMock).toHaveBeenCalledWith('sulla-desktop', expect.stringContaining('task-dispatcher-'));
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
        id: 'dispatch-1', task_id: 'task-1', agent_id: 'sulla-desktop', thread_id: 'thread-1',
      },
      stage_claim: { id: 'stage-claim-1' },
    };
    claimNextMock
      .mockResolvedValueOnce(claim)
      .mockResolvedValue(null);
    executeMock.mockResolvedValue({
      metadata: { agent: { status: 'completed' }, finalSummary: `<WORK_RESULT>{"summary":"Draft PR opened and tests passed.","custody":{"workKind":"code","branch":"feat/test","commitSha":"${ 'a'.repeat(40) }","prUrl":"https://github.com/merchantprotocol/sulla-desktop/pull/123","prHeadSha":"${ 'a'.repeat(40) }","validation":{"tests":"pass"},"provenance":{"agentId":"sulla-desktop"}}}</WORK_RESULT>` },
      messages: [],
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();

    await new Promise(resolve => setTimeout(resolve, 0));
    service.destroy();

    expect(claimNextMock).toHaveBeenCalledWith('sulla-desktop', expect.stringContaining('task-dispatcher-'));
    expect(executeMock).toHaveBeenCalled();
    const workerState = executeMock.mock.calls[0][0];
    expect(workerState.metadata.allowedToolNames).toEqual([
      'browse_tools', 'exec', 'read_file', 'write_file',
    ]);
    expect(workerState.llmTools.map((tool: any) => tool.function.name)).toEqual([
      'browse_tools', 'exec', 'read_file', 'write_file',
    ]);
    expect(finalizeMock).toHaveBeenCalledWith('dispatch-1', 'task-1', expect.objectContaining({
      dispatchStatus: 'completed', taskStatus: 'in_review', taskAssignee: 'heartbeat',
      evidence: expect.objectContaining({ custody: expect.objectContaining({ workKind: 'code' }) }),
    }));
    expect(releaseStageMock).toHaveBeenCalledWith('stage-claim-1');
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('turns user disablement into a visible manual hold without claiming work', async() => {
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'automatedProjectManagementEnabled') return Promise.resolve(false);
      return Promise.resolve(fallback);
    });
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    service.destroy();

    expect(reportCapabilityMock).toHaveBeenCalledWith(expect.objectContaining({
      key:          'todo-execution',
      enabled:      false,
      health:       'unavailable',
      fallbackMode: 'manual_hold',
    }));
    expect(claimNextMock).not.toHaveBeenCalled();
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
        agent_id:  'sulla-desktop',
        thread_id: `verify-thread-${ i }`,
        kind:      'verification',
        attempt:   1,
      },
      stage_claim: { id: `review-stage-${ i }` },
    }));
    claimNextReviewMock
      .mockResolvedValueOnce(claims[0])
      .mockResolvedValueOnce(claims[1])
      .mockResolvedValueOnce(claims[2])
      .mockResolvedValue(null);
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled' || key === 'taskVerifierEnabled' || key === 'taskReviewCoreRoutineEnabled') return Promise.resolve(true);
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
    expect(claimNextReviewMock).toHaveBeenCalledWith('sulla-desktop', [], expect.stringContaining('task-dispatcher-'));
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
          agent_id:  'sulla-desktop',
          thread_id: 'v5',
          kind:      'verification',
          attempt:   1,
        },
        stage_claim: { id: 'review-stage-5' },
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

  it('runs separate default-profile reviewer executions and settles one synthesized verdict', async() => {
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
          agent_id:        'sulla-desktop',
          thread_id:       'core-thread',
          kind:            'verification',
          attempt:         1,
          origin_agent_id: 'sulla-desktop',
        },
        stage_claim: { id: 'review-stage-core' },
      })
      .mockResolvedValue(null);
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled' || key === 'taskVerifierEnabled' || key === 'taskReviewCoreRoutineEnabled') return Promise.resolve(true);
      if (key === 'taskVerifierOwner') return Promise.resolve('core-routine');
      return Promise.resolve(fallback);
    });
    resolvePullRequestHeadMock.mockResolvedValue({
      owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 671, sha: hash,
    });
    resolvePullRequestHeadsMock.mockResolvedValue([{
      owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 671, sha: hash,
    }]);
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
              disposition:    'PASS',
              generationHash: 'f'.repeat(64),
              artifactTypes:  ['code_pr', 'projects_evidence'],
              artifacts:      [
                { type: 'code_pr', canonicalRef: 'merchantprotocol/sulla-desktop#671', hash, adapter: 'github-pr', code: true },
                { type: 'projects_evidence', canonicalRef: 'projects-task:task-core', hash: 'e'.repeat(64), adapter: 'projects-read', code: false },
              ],
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
      'verify-core', expect.stringMatching(/^wfp-/), ['sulla-desktop'],
    );
    const state = executeMock.mock.calls[0][0];
    expect(state.metadata.activeWorkflow.definition.nodes
      .filter((node: any) => node.data?.subtype === 'agent')
      .every((node: any) => node.data?.config?.agentId === 'sulla-desktop')).toBe(true);
    expect(state.metadata.verifierReadOnly).toBe(true);
    expect(finalizeProtectedReviewMock).toHaveBeenCalledWith(
      'verify-core', 'PASS', expect.objectContaining({
        workflowExecutionId: 'wfp-review-1',
        reviewerAgentIds:    ['sulla-desktop'],
        artifactHash:        hash,
      }), expect.any(Array),
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

  it('parses a mixed code and non-code generation with structural adapters', async() => {
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService() as any;
    const { value: parsed, reason } = service.parseProtectedReview({
      workflowId:  'core-routine-review-project-artifact',
      executionId: 'wfp-mixed',
      outcome:     'completed',
      nodeResults: [{
        nodeId: 'node-review-synthesize',
        result: JSON.stringify({
          disposition:    'PASS',
          generationHash: 'f'.repeat(64),
          artifactTypes:  ['code_pr', 'documentation'],
          artifacts:      [
            { type: 'code_pr', canonicalRef: 'org/repo#7', hash: 'a'.repeat(40), adapter: 'github-pr', code: true },
            { type: 'documentation', canonicalRef: 'docs/plan.md', hash: 'b'.repeat(64), adapter: 'document-read', code: false },
          ],
          artifactType: 'mixed',
          artifactRef:  'org/repo#7 + docs/plan.md',
          artifactHash: 'f'.repeat(64),
          summary:      'Both artifacts verified.',
          checks:       ['code', 'document'],
          findings:     [],
          wait:         null,
        }),
      }],
    });
    expect(reason).toBeNull();
    expect(parsed.artifactTypes).toEqual(['code_pr', 'documentation']);
    expect(parsed.artifacts).toHaveLength(2);
    expect(parsed.artifacts[1].adapter).toBe('document-read');
  });

  it.each([
    [{ outcome: 'completed', workflowId: 'wrong-workflow' }, 'workflow_did_not_complete'],
    [{
      outcome: 'completed', workflowId: 'core-routine-review-project-artifact',
      nodeResults: [{ nodeId: 'node-review-synthesize', result: JSON.stringify({ disposition: 'NOPE' }) }],
    }, 'missing_or_invalid_disposition'],
    [{
      outcome: 'completed', workflowId: 'core-routine-review-project-artifact',
      nodeResults: [{ nodeId: 'node-review-synthesize', result: JSON.stringify({ disposition: 'PASS' }) }],
    }, 'invalid_artifact_type'],
  ] as const)('reports a specific reason for malformed protected-review output %#', async(completed, expectedReason) => {
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService() as any;
    const { value, reason } = service.parseProtectedReview(completed);
    expect(value).toBeNull();
    expect(reason).toBe(expectedReason);
  });

  it('rejects malformed verifier output without changing the task to blocked', async() => {
    claimNextReviewMock
      .mockResolvedValueOnce({
        task:     { id: 'task-4', title: 'Review', description: '', project_id: 'p', epic_id: 'e', priority: 'p0' },
        dispatch: { id: 'verify-4', task_id: 'task-4', agent_id: 'sulla-desktop', thread_id: 'v4', kind: 'verification', attempt: 1 },
        stage_claim: { id: 'review-stage-4' },
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
