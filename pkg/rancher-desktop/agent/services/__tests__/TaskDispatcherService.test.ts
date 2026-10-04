import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const settingsGetMock: any = jest.fn();
const recoverStaleMock: any = jest.fn(() => Promise.resolve([]));
const recoverOrphanedVerificationMock: any = jest.fn(() => Promise.resolve([]));
const verificationPoolStatsMock: any = jest.fn(() => Promise.resolve({ backlog: 0, active: 0, suppressedDuplicates: 0, failures: 0 }));
const findRecoverableInProgressMock: any = jest.fn(() => Promise.resolve([]));
const recoverOrphanedInProgressMock: any = jest.fn(() => Promise.resolve([]));
const enumerateCandidatesMock: any = jest.fn(() => Promise.resolve([]));
const countRunningMock: any = jest.fn(() => Promise.resolve(0));
const countByRoleMock: any = jest.fn(() => Promise.resolve({ execution: 0, verification: 0, planning: 0 }));
const countReviewBacklogMock: any = jest.fn(() => Promise.resolve(0));
const claimNextMock: any = jest.fn(() => Promise.resolve(null));
const claimNextReviewMock: any = jest.fn(() => Promise.resolve(null));
const settleMock: any = jest.fn(() => Promise.resolve());
const finalizeMock: any = jest.fn(() => Promise.resolve());
const appendOutcomeJournalMock: any = jest.fn(() => Promise.resolve('journal-1'));
const finalizeOutcomeJournalMock: any = jest.fn(() => Promise.resolve());
const recoverPendingOutcomeJournalsMock: any = jest.fn(() => Promise.resolve([]));
const finalizeVerificationMock: any = jest.fn(() => Promise.resolve('APPROVE'));
const finalizeProtectedReviewMock: any = jest.fn(() => Promise.resolve('PASS'));
const recordReviewLaunchMock: any = jest.fn(() => Promise.resolve());
const recordReviewLaunchWithExecutionMock: any = jest.fn(() => Promise.resolve());
const reconcileDispatcherOwnedExecutionsMock: any = jest.fn(() => Promise.resolve([]));
const failVerificationMock: any = jest.fn(() => Promise.resolve(true));
const touchMock: any = jest.fn(() => Promise.resolve());
const hasActiveDispatchForTaskMock: any = jest.fn(() => Promise.resolve(false));
const addCommentMock: any = jest.fn(() => Promise.resolve());
const updateTaskMock: any = jest.fn(() => Promise.resolve());
const getTaskMock: any = jest.fn(() => Promise.resolve({ id: 'task-core', status: 'in_review' }));
const executeMock: any = jest.fn();
const graphGetMock: any = jest.fn(() => Promise.resolve({
  graph: { execute: executeMock },
  state: { messages: [], metadata: {} },
}));
const graphDeleteMock: any = jest.fn();
const recoverPreviousRuntimeMock: any = jest.fn(() => Promise.resolve([]));
const reportCapabilityMock: any = jest.fn(() => Promise.resolve({}));
const releaseStageMock: any = jest.fn(() => Promise.resolve());
const beginTickMock: any = jest.fn(() => Promise.resolve({}));
const completeTickMock: any = jest.fn(() => Promise.resolve({}));
const resolvePullRequestHeadMock: any = jest.fn();
const resolvePullRequestHeadsMock: any = jest.fn();
const bindReviewGenerationMock: any = jest.fn();
const generationHashMock: any = jest.fn(() => 'f'.repeat(64));
const workflowFindByIdMock: any = jest.fn(() => Promise.resolve({ attributesSnapshot: { enabled: true } }));
const findAgentDirMock: any = jest.fn(() => '/agents/sulla-desktop');
const automationEnabledMock: any = jest.fn(() => Promise.resolve(true));
const resolveLimitMock: any = jest.fn((_scope: string, configured: number) => Promise.resolve(configured));
const acquireSlotMock: any = jest.fn(() => Promise.resolve('slot'));
const releaseSlotMock: any = jest.fn(() => Promise.resolve());
const withStatementTimeoutMock: any = jest.fn((_timeoutMs: number, callback: () => Promise<unknown>) => callback());

jest.unstable_mockModule('../../database/models/WorkLaneDefinitionModel', () => ({
  WorkLaneDefinitionModel: { semanticRoleForStatus: async(_project: string, status: string) =>
    ['in_review', 'qa'].includes(status) ? 'review' : 'execution' },
}));
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
jest.unstable_mockModule('../../database/models/DispatcherLivenessModel', () => ({
  DispatcherLivenessModel: { beginTick: beginTickMock, completeTick: completeTickMock },
}));
jest.unstable_mockModule('../../database/models/WorkTaskDispatchModel', () => ({
  WorkTaskDispatchModel: {
    recoverStale:            recoverStaleMock,
    recoverOrphanedVerification: recoverOrphanedVerificationMock,
    verificationPoolStats:   verificationPoolStatsMock,
    findRecoverableInProgress: findRecoverableInProgressMock,
    recoverOrphanedInProgress: recoverOrphanedInProgressMock,
    enumerateCandidates:      enumerateCandidatesMock,
    countRunning:            countRunningMock,
    countByRole:             countByRoleMock,
    countReviewBacklog:      countReviewBacklogMock,
    claimNext:               claimNextMock,
    claimNextReview:         claimNextReviewMock,
    settle:                  settleMock,
    finalize:                finalizeMock,
    appendOutcomeJournal:    appendOutcomeJournalMock,
    finalizeOutcomeJournal:  finalizeOutcomeJournalMock,
    recoverPendingOutcomeJournals: recoverPendingOutcomeJournalsMock,
    finalizeVerification:    finalizeVerificationMock,
    finalizeProtectedReview: finalizeProtectedReviewMock,
    recordReviewLaunch:      recordReviewLaunchMock,
    recordReviewLaunchWithExecution: recordReviewLaunchWithExecutionMock,
    bindReviewGeneration:    bindReviewGenerationMock,
    reviewGenerationHash:    generationHashMock,
    reviewFingerprint:       jest.fn(() => 'e'.repeat(64)),
    failVerification:        failVerificationMock,
    touch:                   touchMock,
    hasActiveDispatchForTask: hasActiveDispatchForTaskMock,
  },
}));
jest.unstable_mockModule('../../database/models/WorkflowModel', () => ({
  WorkflowModel: { findById: workflowFindByIdMock },
}));
jest.unstable_mockModule('../../database/models/WorkflowExecutionModel', () => ({
  WorkflowExecutionModel: {
    markRunning: jest.fn(() => Promise.resolve()),
    reconcileDispatcherOwnedExecutions: reconcileDispatcherOwnedExecutionsMock,
  },
}));
jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel: {
    addComment:   addCommentMock,
    updateTask:   updateTaskMock,
    getTask:      getTaskMock,
    listComments: jest.fn(() => Promise.resolve([{ author: 'worker', body: 'Draft PR #123 at head.' }])),
    getProject:   jest.fn(() => Promise.resolve({ id: 'p', title: 'Ghost Agent', description: 'Spec: ~/Sites/handoff.txt (section numbers refer to it).' })),
    getEpic:      jest.fn(() => Promise.resolve({ id: 'e', title: 'Sidecar', description: 'Prototype wins where it and the page disagree.' })),
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
    acquire:       acquireSlotMock,
    release:       releaseSlotMock,
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
    recoverPendingOutcomeJournalsMock.mockResolvedValue([]);
    recoverOrphanedVerificationMock.mockResolvedValue([]);
    verificationPoolStatsMock.mockResolvedValue({ backlog: 0, active: 0, suppressedDuplicates: 0, failures: 0 });
    findRecoverableInProgressMock.mockResolvedValue([]);
    recoverOrphanedInProgressMock.mockResolvedValue([]);
    enumerateCandidatesMock.mockResolvedValue([
      { id: 'review-1', status: 'in_review', project_dispatch_enabled: true },
      { id: 'task-1', status: 'todo', project_dispatch_enabled: true },
    ]);
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
    acquireSlotMock.mockResolvedValue('slot');
    releaseSlotMock.mockResolvedValue(undefined);
    withStatementTimeoutMock.mockImplementation((_timeoutMs: number, callback: () => Promise<unknown>) => callback());
  });

  it('uses candidate order for actual mixed-lane selection and passes through waits and ownership', async() => {
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService() as any;
    const selected: string[] = [];
    service.fillExecutionPool = jest.fn(async(id: string) => { selected.push(id); return 1; });
    service.fillVerificationPool = jest.fn(async(id: string) => { selected.push(id); return true; });
    const base = { project_dispatch_enabled: true, has_active_dispatch: false, has_active_stage_claim: false };
    await service.fillCandidatePool([
      { ...base, id: 'paused', status: 'todo', project_dispatch_enabled: false },
      { ...base, id: 'custom', status: 'client_followup', assignee: 'human', labels: ['gated'], has_active_wait: true, unresolved_dependencies: 2 },
      { ...base, id: 'repair', status: 'qa', lane_role: 'review' },
      { ...base, id: 'finished', status: 'shipped', lane_role: 'terminal' },
      { ...base, id: 'busy', status: 'planning', has_active_stage_claim: true },
      { ...base, id: 'resume', status: 'in_progress' },
    ]);
    expect(selected).toEqual(['custom', 'repair', 'resume']);
    expect(service.fillVerificationPool).toHaveBeenCalledWith('repair');
    expect(service.fillExecutionPool).not.toHaveBeenCalledWith('repair');
  });

  it('continues to later candidates after one admission error', async() => {
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService() as any;
    service.fillExecutionPool = (jest.fn() as any).mockRejectedValueOnce(new Error('admission failed')).mockResolvedValueOnce(1);
    const base = { project_dispatch_enabled: true, status: 'todo' };
    await expect(service.fillCandidatePool([{ ...base, id: 'broken' }, { ...base, id: 'later' }])).resolves.toBe(1);
    expect(service.fillExecutionPool.mock.calls).toEqual([['broken'], ['later']]);
  });

  it('does not start a fourth worker across review and execution lanes', async() => {
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService() as any;
    countRunningMock.mockResolvedValue(3);
    service.fillExecutionPool = jest.fn();
    service.fillVerificationPool = jest.fn();
    await service.fillCandidatePool([
      { id: 'execution', status: 'blocked', project_dispatch_enabled: true },
      { id: 'review', status: 'in_review', project_dispatch_enabled: true },
    ]);
    expect(service.fillExecutionPool).not.toHaveBeenCalled();
    expect(service.fillVerificationPool).not.toHaveBeenCalled();
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

  it('releases the tick gate when candidate enumeration never settles', async() => {
    jest.useFakeTimers();
    try {
      settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
        if (key === 'taskDispatcherTickTimeoutMs') return Promise.resolve(1_000);
        if (key === 'taskVerifierOwner') return Promise.resolve('legacy');
        return Promise.resolve(fallback);
      });
      findRecoverableInProgressMock.mockResolvedValue([{
        task: { id: 'hung-pr-task', github_issue: 'merchantprotocol/sulla-desktop#1' },
        exclusionReasons: [],
      }]);
      const { TaskDispatcherService } = await import('../TaskDispatcherService');
      const service = new TaskDispatcherService() as any;
      enumerateCandidatesMock.mockImplementationOnce(() => new Promise(() => {}));
      const initialized = service.initialize();

      await jest.advanceTimersByTimeAsync(1_000);
      await initialized;
      findRecoverableInProgressMock.mockResolvedValue([]);
      await jest.advanceTimersByTimeAsync(59_000);

      expect(enumerateCandidatesMock).toHaveBeenCalledTimes(2);
      expect(countRunningMock).toHaveBeenCalled();
      expect(completeTickMock).toHaveBeenCalledWith(60_000, 'error');
      service.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('releases the tick gate when a statement-timeout tick query never settles', async() => {
    jest.useFakeTimers();
    try {
      settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
        if (key === 'taskDispatcherTickTimeoutMs') return Promise.resolve(1_000);
        if (key === 'taskVerifierOwner') return Promise.resolve('legacy');
        return Promise.resolve(fallback);
      });
      withStatementTimeoutMock
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockImplementation((_timeoutMs: number, callback: () => Promise<unknown>) => callback());
      const { TaskDispatcherService } = await import('../TaskDispatcherService');
      const service = new TaskDispatcherService();
      const initialized = service.initialize();

      await jest.advanceTimersByTimeAsync(1_000);
      await initialized;
      await jest.advanceTimersByTimeAsync(59_000);

      expect(withStatementTimeoutMock.mock.calls.length).toBeGreaterThan(1);
      expect(countRunningMock).toHaveBeenCalled();
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
    expect(recoverStaleMock).toHaveBeenCalledWith(undefined, []);
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
    expect(claimNextMock).toHaveBeenCalled();
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

    expect(recoverStaleMock).toHaveBeenCalledWith(undefined, []);
    expect(recoverPreviousRuntimeMock).toHaveBeenCalledWith('todo-execution', expect.stringContaining('task-dispatcher-'));
    expect(countRunningMock).toHaveBeenCalled();
  });

  it('considers the whole portfolio and does not hide execution behind review backlog', async() => {
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
    expect(enumerateCandidatesMock).toHaveBeenCalledTimes(1);
    expect(countReviewBacklogMock).not.toHaveBeenCalled();
    expect(claimNextMock).toHaveBeenCalled();
  });

  it('keeps review and execution admission independent', async() => {
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

    expect(findRecoverableInProgressMock).not.toHaveBeenCalled();
    expect(recoverOrphanedInProgressMock).not.toHaveBeenCalled();
  });

  it('uses broad in-lane admission even when legacy recovery is enabled', async() => {
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

    expect(recoverOrphanedInProgressMock).not.toHaveBeenCalled();
    expect(claimNextMock).toHaveBeenCalled();
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

    expect(claimNextMock).toHaveBeenCalledWith(
      'sulla-desktop', expect.stringContaining('task-dispatcher-'), undefined, 'task-1',
    );
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
    executeMock
      .mockResolvedValueOnce({
        metadata: { agent: { status: 'completed' }, finalSummary: 'CI is still running; waiting for it.' },
        messages: [],
      })
      .mockResolvedValueOnce({
        metadata: { agent: { status: 'completed' }, finalSummary: `<WORK_RESULT>{"summary":"Draft PR opened; CI pending.","custody":{"workKind":"code","branch":"feat/test","commitSha":"${ 'a'.repeat(40) }","prUrl":"https://github.com/merchantprotocol/sulla-desktop/pull/123","prHeadSha":"${ 'a'.repeat(40) }","validation":{"tests":"pass"},"provenance":{"agentId":"sulla-desktop"}}}</WORK_RESULT>` },
        messages: [],
      });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();

    await new Promise(resolve => setTimeout(resolve, 0));
    service.destroy();

    expect(claimNextMock).toHaveBeenCalledWith(
      'sulla-desktop', expect.stringContaining('task-dispatcher-'), undefined, 'task-1',
    );
    expect(executeMock).toHaveBeenCalledTimes(2);
    const workerState = executeMock.mock.calls[0][0];
    // Workers get exactly the full agent tool set the primary chat gets.
    const fullSet = ['browse_tools', 'exec', 'read_file', 'write_file', 'ask_user_question', 'browser_controller'];
    expect(workerState.metadata.allowedToolNames).toEqual(fullSet);
    expect(workerState.llmTools.map((tool: any) => tool.function.name)).toEqual(fullSet);
    // Workers see the plan context the task cites and the task history (review findings on repair rounds).
    expect(workerState.messages[0].content).toContain('Spec: ~/Sites/handoff.txt');
    expect(workerState.messages[0].content).toContain('Prototype wins where it and the page disagree.');
    expect(workerState.messages[0].content).toContain('Draft PR #123 at head.');
    expect(workerState.messages.some((message: any) => String(message.content).includes('If a background check or CI is still running, report it as pending'))).toBe(true);
    expect(appendOutcomeJournalMock).toHaveBeenCalledWith('dispatch-1', 'task-1', expect.objectContaining({
      dispatchStatus: 'completed', taskStatus: 'in_review', taskAssignee: 'heartbeat',
      evidence: expect.objectContaining({ custody: expect.objectContaining({ workKind: 'code' }) }),
    }));
    expect(finalizeOutcomeJournalMock).toHaveBeenCalledWith('journal-1');
    expect(releaseStageMock).toHaveBeenCalledWith('stage-claim-1');
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it.each(['execution', 'verification'])('retains a %s writer past timeout until execution returns', async(kind) => {
    jest.useFakeTimers();
    try {
      let finish!: (state: any) => void;
      executeMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
        if (key === 'taskDispatcherExecutionTimeoutMinutes') return Promise.resolve(0.001);
        if (key === 'taskVerifierTimeoutMinutes') return Promise.resolve(1);
        return Promise.resolve(fallback);
      });
      const { TaskDispatcherService } = await import('../TaskDispatcherService');
      const service = new TaskDispatcherService() as any;
      const run = service.runClaim({
        task: { id: 'slow', status: 'in_review', title: 'Repair', project_id: 'p', epic_id: 'e' },
        dispatch: { id: 'slow-dispatch', task_id: 'slow', agent_id: 'sulla-desktop', thread_id: 'slow-thread', kind },
        stage_claim: { id: 'slow-stage' },
      });
      await jest.advanceTimersByTimeAsync(120001);
      expect(service.active.has('slow-dispatch')).toBe(true);
      expect(settleMock).not.toHaveBeenCalled();
      expect(failVerificationMock).not.toHaveBeenCalled();
      expect(releaseStageMock).not.toHaveBeenCalled();
      expect(graphDeleteMock).not.toHaveBeenCalled();
      expect(touchMock).toHaveBeenCalledWith('slow-dispatch');
      finish({ messages: [], metadata: {} });
      await run;
      expect(releaseStageMock).toHaveBeenCalledWith('slow-stage');
      expect(service.active.has('slow-dispatch')).toBe(false);
      if (kind === 'verification') expect(failVerificationMock).toHaveBeenCalledWith('slow-dispatch', 'verifier_timeout');
      else expect(settleMock).toHaveBeenCalledWith('slow-dispatch', 'timed_out', undefined, 'execution exceeded 0.001 minute(s)');
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps ownership when a completed parent still has an unconfirmed background writer', async() => {
    jest.useFakeTimers();
    try {
      let writerAlive = true;
      const state = { messages: [], metadata: { lastCompletedWorkflow: { outcome: 'failed' } } };
      graphGetMock.mockResolvedValueOnce({
        graph: { execute: async() => state, hasUnconfirmedWorkflowWorkers: () => writerAlive }, state,
      });
      const { TaskDispatcherService } = await import('../TaskDispatcherService');
      const service = new TaskDispatcherService() as any;
      const run = service.runClaim({
        task: { id: 'background', status: 'qa', project_id: 'p', epic_id: 'e' },
        dispatch: { id: 'background-dispatch', task_id: 'background', agent_id: 'sulla-desktop', thread_id: 'background', kind: 'verification' },
        stage_claim: { id: 'background-stage' },
      });
      await jest.advanceTimersByTimeAsync(120001);
      expect(releaseStageMock).not.toHaveBeenCalled();
      expect(failVerificationMock).not.toHaveBeenCalled();
      expect(service.active.has('background-dispatch')).toBe(true);
      writerAlive = false;
      await jest.advanceTimersByTimeAsync(1500);
      await run;
      expect(releaseStageMock).toHaveBeenCalledWith('background-stage');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([false, true])('drains background writers from WORK_RESULT recovery before settlement (timeout=%s)', async(timeout) => {
    jest.useFakeTimers();
    try {
      let writerAlive = false;
      const state = { messages: [], metadata: { agent: { status: 'completed' }, finalSummary: 'Missing result' } };
      const execute = jest.fn<any>()
        .mockResolvedValueOnce(state)
        .mockImplementationOnce(async() => {
          writerAlive = true;
          state.metadata.finalSummary = '<WORK_RESULT>{"summary":"Repair complete"}</WORK_RESULT>';
          return state;
        });
      graphGetMock.mockResolvedValueOnce({
        graph: { execute, hasUnconfirmedWorkflowWorkers: () => writerAlive }, state,
      });
      settingsGetMock.mockImplementation((key: string, fallback: unknown) => Promise.resolve(
        key === 'taskDispatcherExecutionTimeoutMinutes' ? (timeout ? 0.001 : 45) : fallback,
      ));
      const { TaskDispatcherService } = await import('../TaskDispatcherService');
      const service = new TaskDispatcherService() as any;
      const run = service.runClaim({
        task: { id: 'recovery', status: 'in_progress', project_id: 'p', epic_id: 'e' },
        dispatch: { id: 'recovery-dispatch', task_id: 'recovery', agent_id: 'sulla-desktop', thread_id: 'recovery', kind: 'execution' },
        stage_claim: { id: 'recovery-stage' },
      });
      await jest.advanceTimersByTimeAsync(120001);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(service.active.has('recovery-dispatch')).toBe(true);
      expect(releaseStageMock).not.toHaveBeenCalled();
      expect(appendOutcomeJournalMock).not.toHaveBeenCalled();
      expect(settleMock).not.toHaveBeenCalled();
      expect(graphDeleteMock).not.toHaveBeenCalled();
      writerAlive = false;
      await jest.advanceTimersByTimeAsync(1500);
      await run;
      expect(releaseStageMock).toHaveBeenCalledWith('recovery-stage');
      if (timeout) expect(settleMock).toHaveBeenCalledWith('recovery-dispatch', 'timed_out', undefined, expect.any(String));
      else expect(appendOutcomeJournalMock).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('turns user disablement into a visible manual hold without claiming work', async() => {
    automationEnabledMock.mockResolvedValue(false);
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
    enumerateCandidatesMock.mockResolvedValue(claims.map((claim: any) => ({ ...claim.task, status: 'in_review', project_dispatch_enabled: true })));
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

    // Finished workers refill the pool; null claim probes do not launch workers.
    expect(claimNextReviewMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect((await Promise.all(claimNextReviewMock.mock.results.map((result: { value: unknown }) => result.value))).filter(Boolean)).toHaveLength(3);
    expect(claimNextReviewMock).toHaveBeenCalledWith('sulla-desktop', [], expect.stringContaining('task-dispatcher-'), expect.any(String));
    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(finalizeVerificationMock).toHaveBeenCalledTimes(3);
    expect(finalizeVerificationMock).toHaveBeenCalledWith(
      'verify-1', 'APPROVE', 'a'.repeat(40), 'a'.repeat(40), 'All criteria and focused tests passed.',
    );
    expect(resolvePullRequestHeadMock).toHaveBeenCalledTimes(3);
    const verifierState = executeMock.mock.calls[0][0];
    // Reviewers have full authority: exec (the whole Sulla catalog) and no read-only sandbox.
    expect(verifierState.metadata.allowedToolNames).toContain('git_diff');
    expect(verifierState.metadata.allowedToolNames).toContain('exec');
    expect(verifierState.metadata.verifierReadOnly).toBeUndefined();
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

    // The protected reviewer judges against the same plan context the worker built from.
    expect(recordReviewLaunchWithExecutionMock).toHaveBeenCalledWith(
      'verify-core', expect.objectContaining({
        triggerInput: expect.stringContaining('Spec: ~/Sites/handoff.txt'),
      }),
    );
    expect(recordReviewLaunchWithExecutionMock).toHaveBeenCalledWith(
      'verify-core', expect.objectContaining({
        executionId: expect.stringMatching(/^wfp-/),
        scopeTaskId: 'task-core',
        reviewerAgentIds: ['sulla-desktop'],
      }),
    );
    const state = executeMock.mock.calls[0][0];
    expect(state.metadata.activeWorkflow.definition.nodes
      .filter((node: any) => node.data?.subtype === 'agent')
      .every((node: any) => node.data?.config?.agentId === 'sulla-desktop')).toBe(true);
    expect(state.metadata.verifierReadOnly).toBeUndefined();
    expect(state.metadata.allowedToolNames).toContain('exec');
    expect(finalizeProtectedReviewMock).toHaveBeenCalledWith(
      'verify-core', 'PASS', expect.objectContaining({
        workflowExecutionId: 'wfp-review-1',
        reviewerAgentIds:    ['sulla-desktop'],
        artifactHash:        hash,
      }), expect.any(Array),
    );
  });

  it('settles a synthesis abstention as artifact_generation_changed when the task is no longer live in_review', async() => {
    claimNextReviewMock
      .mockResolvedValueOnce({
        task: {
          id:           'task-core',
          title:        'Core review',
          description:  'Verify all criteria.',
          project_id:   'p',
          epic_id:      'e',
          priority:     'critical',
          github_issue: null,
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
    resolvePullRequestHeadsMock.mockResolvedValue([]);
    getTaskMock.mockResolvedValueOnce({ id: 'task-core', status: 'todo' });
    executeMock.mockResolvedValue({
      metadata: {
        agent:                 { status: 'completed' },
        finalSummary:          'Routine complete.',
        lastCompletedWorkflow: {
          workflowId:  'core-routine-review-project-artifact',
          executionId: 'wfp-review-2',
          outcome:     'completed',
          nodeResults: [{ nodeId: 'node-review-synthesize', result: 'No disposition JSON is being issued: there is no live in_review generation to transition.' }],
        },
      },
      messages: [],
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    await new Promise(resolve => setTimeout(resolve, 10));
    service.destroy();

    expect(getTaskMock).toHaveBeenCalledWith('task-core');
    expect(failVerificationMock).toHaveBeenCalledWith(
      'verify-core', expect.stringMatching(/^artifact_generation_changed:/),
    );
    expect(failVerificationMock).not.toHaveBeenCalledWith(
      'verify-core', expect.stringMatching(/^malformed_protected_review_output:/),
    );
  });

  it('settles a missing disposition as malformed_protected_review_output when the task is still live in_review', async() => {
    claimNextReviewMock
      .mockResolvedValueOnce({
        task: {
          id:           'task-core',
          title:        'Core review',
          description:  'Verify all criteria.',
          project_id:   'p',
          epic_id:      'e',
          priority:     'critical',
          github_issue: null,
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
    resolvePullRequestHeadsMock.mockResolvedValue([]);
    getTaskMock.mockResolvedValueOnce({ id: 'task-core', status: 'in_review' });
    executeMock.mockResolvedValue({
      metadata: {
        agent:                 { status: 'completed' },
        finalSummary:          'Routine complete.',
        lastCompletedWorkflow: {
          workflowId:  'core-routine-review-project-artifact',
          executionId: 'wfp-review-3',
          outcome:     'completed',
          nodeResults: [{ nodeId: 'node-review-synthesize', result: 'not json' }],
        },
      },
      messages: [],
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();
    await new Promise(resolve => setTimeout(resolve, 10));
    service.destroy();

    expect(getTaskMock).toHaveBeenCalledWith('task-core');
    expect(failVerificationMock).toHaveBeenCalledWith(
      'verify-core', 'malformed_protected_review_output:missing_or_invalid_disposition',
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
