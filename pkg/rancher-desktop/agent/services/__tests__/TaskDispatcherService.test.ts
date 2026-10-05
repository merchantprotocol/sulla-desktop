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
jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({ WorkItemsModel: {} }));
jest.unstable_mockModule('../../database/models/WorkTaskDispatchModel', () => ({ WorkTaskDispatchModel: {} }));
jest.unstable_mockModule('../../database/models/WorkLaneDefinitionModel', () => ({ WorkLaneDefinitionModel: {} }));
jest.unstable_mockModule('../../database/models/WorkflowModel', () => ({ WorkflowModel: {} }));
jest.unstable_mockModule('../../database/models/WorkflowExecutionModel', () => ({ WorkflowExecutionModel: {} }));
jest.unstable_mockModule('../../tools/agents/agentTurnOutcome', () => ({ extractAgentTurnOutcome: {} }));
jest.unstable_mockModule('../../tools/registry', () => ({ toolRegistry: {} }));
jest.unstable_mockModule('../../workflow/WorkflowPlaybook', () => ({ createPlaybookState: {} }));
jest.unstable_mockModule('../../routines/core/defaultCoreAgent', () => ({ DEFAULT_CORE_ROUTINE_AGENT_ID: 'sulla-desktop' }));
jest.unstable_mockModule('../../routines/core/reviewProjectArtifact', () => ({
  REVIEW_PROJECT_ARTIFACT_DEFINITION: {}, REVIEW_PROJECT_ARTIFACT_ID: 'review', ARTIFACT_VERIFICATION_ADAPTERS: {},
}));
jest.unstable_mockModule('../../tools/fullAgentTools', () => ({ FULL_AGENT_TOOL_NAMES: [] }));

let Service: any;
beforeAll(async() => { Service = (await import('../TaskDispatcherService')).TaskDispatcherService; });
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
