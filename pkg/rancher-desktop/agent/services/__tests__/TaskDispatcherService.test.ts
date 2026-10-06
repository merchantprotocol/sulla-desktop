/** @jest-environment node */
import { beforeAll, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../AbortService', () => ({ AbortService: {} }));
jest.unstable_mockModule('../ArtifactCustodyPolicy', () => ({ ArtifactCustodyPolicy: {} }));
jest.unstable_mockModule('../ArtifactReceiptService', () => ({ buildReceipt: {}, renderReceiptComment: {} }));
jest.unstable_mockModule('../GitHubPullRequestHeadService', () => ({ resolvePullRequestHead: {}, resolvePullRequestHeads: {} }));
jest.unstable_mockModule('../GraphRegistry', () => ({ GraphRegistry: {} }));
jest.unstable_mockModule('../ProjectAutomationWipLimits', () => ({ resolveWipLimits: {}, evaluateClaim: {} }));
jest.unstable_mockModule('../RoutineConcurrencyPolicy', () => ({ RoutineConcurrencyPolicy: {} }));
jest.unstable_mockModule('../../database/PostgresClient', () => ({ postgresClient: {} }));
jest.unstable_mockModule('../../database/models/DispatcherLivenessModel', () => ({ DispatcherLivenessModel: {} }));
jest.unstable_mockModule('../../database/models/LifecycleCapabilityModel', () => ({ LifecycleCapabilityModel: {} }));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({ SullaSettingsModel: {} }));
jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({ WorkItemsModel: { addComment } }));
jest.unstable_mockModule('../../database/models/WorkTaskDispatchModel', () => ({ WorkTaskDispatchModel: { settle, recordReviewLaunchWithExecution: recordReviewLaunch, reviewGenerationHash: (artifacts: any[]) => artifacts.map(a => a.hash).join('').padEnd(64, '0').slice(0, 64) } }));
jest.unstable_mockModule('../../database/models/WorkLaneDefinitionModel', () => ({ WorkLaneDefinitionModel: {} }));
jest.unstable_mockModule('../../database/models/WorkflowModel', () => ({ WorkflowModel: {} }));
jest.unstable_mockModule('../../database/models/WorkflowExecutionModel', () => ({ WorkflowExecutionModel: {} }));
jest.unstable_mockModule('../../tools/agents/agentTurnOutcome', () => ({ extractAgentTurnOutcome: {} }));
jest.unstable_mockModule('../../tools/registry', () => ({ toolRegistry: {} }));
jest.unstable_mockModule('../../workflow/WorkflowPlaybook', () => ({ createPlaybookState: {}, createPlaybookStateFromNode: retryPlaybook }));
jest.unstable_mockModule('../../routines/core/defaultCoreAgent', () => ({ DEFAULT_CORE_ROUTINE_AGENT_ID: 'sulla-desktop' }));
jest.unstable_mockModule('../../routines/core/reviewProjectArtifact', () => ({
  REVIEWER_NODE_IDS: ['node-review-code', 'node-review-deliverable', 'node-review-risk'],
  REVIEW_PROJECT_ARTIFACT_DEFINITION: { nodes: [] }, REVIEW_PROJECT_ARTIFACT_ID: 'review', ARTIFACT_VERIFICATION_ADAPTERS: { code_pr: { adapter: 'github-pr', tools: [] }, projects_evidence: { adapter: 'projects-read', tools: [] } },
}));
jest.unstable_mockModule('../../tools/fullAgentTools', () => ({ FULL_AGENT_TOOL_NAMES: [] }));

const recordReviewLaunch = jest.fn<any>().mockResolvedValue(undefined);
const retryPlaybook = jest.fn<any>().mockReturnValue({ executionId: 'retry', currentNodeIds: ['node-review-synthesize'] });
const settle = jest.fn<any>().mockResolvedValue(undefined);
const addComment = jest.fn<any>().mockResolvedValue(undefined);
let Service: any;
let boundedOutcomeText: (text: string, cap?: number) => string;
beforeAll(async() => {
  ({ TaskDispatcherService: Service, boundedOutcomeText } = await import('../TaskDispatcherService'));
});
const candidate = (id: string, overrides = {}) => ({
  id, status: 'todo', lane_role: 'execution', project_dispatch_enabled: true,
  has_active_dispatch: false, has_active_stage_claim: false, ...overrides,
});
describe('whole-board dispatcher consideration', () => {
  it('attempts every independent card beyond the previous three and 32 job limits', async() => {
    const service = new Service();
    service.fillExecutionPool = jest.fn<any>().mockResolvedValue(1);
    const rows = Array.from({ length: 40 }, (_, i) => candidate(String(i)));
    expect(await service.fillCandidatePool(rows)).toBe(40);
    expect(service.fillExecutionPool).toHaveBeenCalledTimes(40);
    expect(service.lastConsideration).toEqual({ considered: 40, dispatched: 40, holds: {} });
  });
  it('counts held cards and continues after a failed claim', async() => {
    const service = new Service();
    service.fillExecutionPool = jest.fn<any>().mockRejectedValueOnce(new Error('database failure')).mockResolvedValue(1);
    service.fillVerificationPool = jest.fn<any>().mockResolvedValue(false);
    expect(await service.fillCandidatePool([
      candidate('paused', { project_dispatch_enabled: false }),
      candidate('done', { status: 'done', lane_role: 'terminal' }),
      candidate('owned', { has_active_dispatch: true }),
      candidate('failed'), candidate('next'), candidate('review', { status: 'in_review' }),
    ])).toBe(1);
    expect(service.lastConsideration).toEqual({ considered: 6, dispatched: 1, holds: {
      'project explicitly paused': 1, 'terminal task': 1, 'live owner': 1,
      'admission error': 1, 'review unavailable or ownership conflict': 1,
    } });
    expect(service.fillExecutionPool).toHaveBeenCalledWith('next');
  });
});

describe('direct task comment handoff', () => {
  it('bounds diagnostics without preserving legacy result blocks', () => {
    const text = `${ 'x'.repeat(8000) }<WORK_RESULT>${ 'y'.repeat(9000) }</WORK_RESULT>`;
    expect(boundedOutcomeText(text)).toBe('x'.repeat(8000));
  });
  it('includes complete task details and all comments beyond the former budget', () => {
    const service = new Service();
    const task = { id: 'task', title: 'Full task', description: 'Acceptance', github_issue: 'owner/repo#1' };
    const body = 'x'.repeat(210000);
    const prompt = service.buildWorkerPrompt(task, 'dispatch', 'worker', [
      { author: 'human', body }, { author: 'reviewer', body: 'latest finding' },
    ]);
    expect(prompt).toContain(JSON.stringify(task));
    expect(prompt).toContain(body);
    expect(prompt).toContain('latest finding');
    expect(prompt).toContain('project/add_task_comment');
    expect(prompt).toContain('project/update_task');
    expect(prompt).not.toContain('WORK_RESULT');
  });
  it.each(['completed', 'blocked', 'failed'])('settles %s without rewriting the task lane', async(status) => {
    settle.mockClear(); addComment.mockClear();
    await new Service().finalizeClaim({ task: { id: 'task', status: 'in_progress' }, dispatch: { id: 'dispatch' } }, status, 'plain response');
    expect(settle).toHaveBeenCalledWith('dispatch', status, 'plain response', status === 'failed' ? 'plain response' : undefined);
    expect(addComment).toHaveBeenCalledTimes(status === 'failed' ? 1 : 0);
  });
});

describe('dead-run settlement', () => {
  it('settles a dead work run as timed out, keeps the lane, and leaves an audit comment', async() => {
    settle.mockClear(); addComment.mockClear();
    await new Service().settleDeadRun(
      { id: 'dispatch-dead', task_id: 'task' }, false, 'no agent activity for 30 minute(s)', { metadata: {} },
    );
    expect(settle).toHaveBeenCalledWith('dispatch-dead', 'timed_out', undefined, 'dead run: no agent activity for 30 minute(s)');
    expect(addComment).toHaveBeenCalledWith(expect.objectContaining({
      task_id: 'task',
      author:  'dispatcher',
      body:    expect.stringContaining('Stopped work run dispatch-dead as dead (no agent activity for 30 minute(s))'),
    }));
  });
});


describe('system-owned review evidence', () => {
  const artifact = (ref: string, hash = 'a'.repeat(40)) => ({
    type: 'code_pr', canonicalRef: ref, hash, adapter: 'github-pr', code: true, url: null,
  });
  const completed = (result: unknown) => ({ workflowId: 'review', outcome: 'completed',
    nodeResults: [{ nodeId: 'node-review-synthesize', result: JSON.stringify(result) }] });

  it('accepts a valid judgment despite missing or corrupted model-echoed hashes', () => {
    const service = new Service();
    const artifacts = [artifact('owner/repo#1')];
    const parsed = service.parseProtectedReview(completed({
      disposition: 'PASS', generationHash: 'wrong', artifactHash: 'wrong',
      artifacts: [artifact('unrelated/repo#8')], summary: 'Criteria verified', checks: [], findings: [],
    }), artifacts);
    expect(parsed.value).not.toBeNull();
    expect(parsed.value.artifacts).toEqual(artifacts);
    expect(parsed.value.artifactHash).toBe('a'.repeat(40));
    expect(parsed.value.artifactRef).toBe('owner/repo#1');
  });

  it('runs synthesis once with preserved outputs even if the retry is still malformed', async() => {
    const service = new Service();
    service.awaitWriterTermination = jest.fn<any>().mockResolvedValue(undefined);
    const original = { ...completed({}), completedAt: 'now', nodeResults: [
      { nodeId: 'node-review-code', result: 'Original findings', label: 'Code and PR Reviewer' },
    ] };
    const state = { messages: [], metadata: { lastCompletedWorkflow: original, cycleComplete: true, waitingForUser: true } };
    const graph = { execute: jest.fn<any>().mockImplementation(async(s: any) => {
      expect(s.metadata.cycleComplete).toBe(false);
      expect(s.metadata.waitingForUser).toBe(false);
      s.metadata.lastCompletedWorkflow = completed({ summary: 'Still missing verdict' }); return s;
    }) };
    const result = await service.retryProtectedSynthesis(state, original, { id: 'dispatch', task_id: 'task' },
      ['reviewer'], 'missing_or_invalid_disposition', graph, (work: Promise<any>) => work);
    expect(graph.execute).toHaveBeenCalledTimes(1);
    expect(retryPlaybook).toHaveBeenLastCalledWith({ nodes: [] }, 'node-review-synthesize', {
      'node-review-code': { ...original.nodeResults[0], completedAt: 'now' },
    });
    expect(recordReviewLaunch).toHaveBeenLastCalledWith('dispatch', expect.objectContaining({ executionId: 'retry', scopeTaskId: 'task' }));
    expect(service.parseProtectedReview(result.metadata.lastCompletedWorkflow, [artifact('owner/repo#1')]).value).toBeNull();
  });

  it('retries completed synthesis only when all original reviewer outputs survive', () => {
    const service = new Service();
    const evidence = { ...completed({}), nodeResults: ['code', 'deliverable', 'risk'].map(lens => ({
      nodeId: `node-review-${ lens }`, result: '{"verdict":"pass"}',
    })) };
    expect(service.hasRetryableReviewOutput(evidence)).toBe(true);
    expect(service.hasRetryableReviewOutput({ ...evidence, outcome: 'failed' })).toBe(false);
    expect(service.hasRetryableReviewOutput({ ...evidence, nodeResults: evidence.nodeResults.slice(1) })).toBe(false);
  });

  it('still rejects malformed judgments rather than inventing a disposition', () => {
    const service = new Service();
    expect(service.parseProtectedReview(completed({ summary: 'No verdict' }), [artifact('owner/repo#1')]).value).toBeNull();
    expect(service.parseProtectedReview({ outcome: 'failed', workflowId: 'review' }, [artifact('owner/repo#1')]).value).toBeNull();
  });

  it('ignores another PR changing but preserves a changed head on the bound PR', () => {
    const service = new Service();
    const claimed = [artifact('owner/repo#1')];
    expect(service.boundReviewArtifacts(claimed, [artifact('owner/repo#2', 'b'.repeat(40)), ...claimed])).toEqual(claimed);
    expect(service.boundReviewArtifacts(claimed, [artifact('owner/repo#1', 'b'.repeat(40))])[0].hash).toBe('b'.repeat(40));
    expect(service.boundReviewArtifacts(claimed, [artifact('owner/repo#2')])).toBeNull();
  });
});
