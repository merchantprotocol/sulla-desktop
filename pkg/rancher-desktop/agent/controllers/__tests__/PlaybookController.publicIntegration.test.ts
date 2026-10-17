/** @jest-environment node */
import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('fs', () => ({ appendFileSync: jest.fn() }));
jest.unstable_mockModule('../../services/ConversationLogger', () => ({ getConversationLogger: jest.fn() }));
jest.unstable_mockModule('../../services/WebSocketClientService', () => ({ getWebSocketClientService: jest.fn(() => ({ send: jest.fn() })) }));
jest.unstable_mockModule('../../database/models/ChatMessageModel', () => ({ ChatMessageModel: {} }));
jest.unstable_mockModule('../../workflow/lockedCoreRoutineExecution', () => ({ inheritSubAgentToolPolicy: jest.fn(), lockedCoreBlockedError: jest.fn(), resolveAgentTaskForDispatch: jest.fn() }));
jest.unstable_mockModule('../../database/RedisClient', () => ({ redisClient: { get: jest.fn(() => Promise.resolve(null)) } }));
jest.unstable_mockModule('../../tools/workflow/stop_workflow', () => ({ stopKey: () => 'stop' }));
jest.unstable_mockModule('../../tools/workflow/pause_workflow', () => ({ pauseKey: () => 'pause' }));
jest.unstable_mockModule('../../database/models/WorkflowPendingCompletionModel', () => ({ WorkflowPendingCompletionModel: { findPending: jest.fn(() => Promise.resolve([])) } }));
jest.unstable_mockModule('../../database/models/WorkflowExecutionModel', () => ({ WorkflowExecutionModel: {} }));
jest.unstable_mockModule('../../database/models/WorkflowCheckpointModel', () => ({ WorkflowCheckpointModel: {} }));
jest.unstable_mockModule('../../tools/registry', () => ({ toolRegistry: {} }));
jest.unstable_mockModule('../../workflow/WorkflowRegistry', () => ({ getWorkflowRegistry: jest.fn() }));
jest.unstable_mockModule('../../workflow/WorkflowPlaybook', () => ({
  createPlaybookState: jest.fn(), resolveDecision: jest.fn(), processNextStep: jest.fn(), completeSubAgent: jest.fn(),
}));

const call = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ public: true });
const getClient = jest.fn(() => ({
  getEndpoint: jest.fn(() => ({ endpoint: { auth: 'none' } })),
  call,
}));
jest.unstable_mockModule('../../integrations/configApi', () => ({
  getIntegrationConfigLoader: () => ({ getClient }),
}));

const issueLocalBrokerContext = jest.fn(() => Promise.reject(new Error('broker status unavailable')));
jest.unstable_mockModule('../../../vault-broker', () => ({
  usesContainerVaultAuthority: () => true,
  issueLocalBrokerContext,
}));

const { PlaybookController } = await import('../PlaybookController');

describe('PlaybookController public integration routing', () => {
  it('executes an auth:none manifest endpoint without consulting broker status', async() => {
    const controller: any = new PlaybookController({
      execute:       (state: unknown) => Promise.resolve(state),
      getEntryPoint: () => null,
      getNode:       () => null,
    });
    const result = await controller.executeToolCall(
      { metadata: {} },
      { integrationSlug: 'public-api', endpointName: 'list', accountId: 'default', defaults: { limit: '1' } },
    );

    expect(result).toEqual({ output: { public: true } });
    expect(issueLocalBrokerContext).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith('list', { limit: '1' }, { accountId: 'default' });
  });
});
