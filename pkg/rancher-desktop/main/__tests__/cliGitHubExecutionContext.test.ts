/** @jest-environment node */

import { expect, it, jest } from '@jest/globals';

import mockModules from '@pkg/utils/testUtils/mockModules';

const now = Math.floor(Date.now() / 1000);
const trustedState = {
  metadata: {
    agentId:         'trusted-agent',
    threadId:        'trusted-thread',
    podId:           'trusted-pod',
    jobId:           'trusted-job',
    orgId:           'trusted-org',
    allowedToolNames: ['github_list_prs'],
  },
};
const getToolSession = jest.fn<(token: string) => any>();
const issueLocalBrokerContext = jest.fn<(input: any) => Promise<any>>();
const createTool = jest.fn<(name: string) => Promise<any>>();
const getExecutionTarget = jest.fn<(name: string) => string>()
  .mockImplementation(name => name === 'github_list_prs' ? 'catalog' : 'agent-local');
const containerRuntimeForExecution = jest.fn<(...args: any[]) => any>().mockReturnValue(undefined);
const withAgentContainerRuntime = jest.fn((_runtime: any, action: () => any) => action());

mockModules({
  '@pkg/agent/database/models/SullaSettingsModel': { SullaSettingsModel: { get: jest.fn(), set: jest.fn() } },
  '@pkg/agent/services/AgentContainerRuntimeRegistry': { containerRuntimeForExecution, withAgentContainerRuntime },
  '@pkg/agent/services/GraphRegistry':             { GraphRegistry: {}, nextThreadId: jest.fn(), nextMessageId: jest.fn() },
  '@pkg/agent/services/IntegrationService':        { getIntegrationService: () => ({ getActiveAccountId: async() => 'trusted-account' }) },
  '@pkg/agent/services/WebSocketClientService':    { getWebSocketClientService: () => ({ connect: jest.fn(), onMessage: jest.fn(), send: jest.fn() }) },
  '@pkg/agent/tools/registry':                     {
    toolRegistry: {
      createTool,
      findSimilarToolNames: jest.fn(() => []),
      getExecutionTarget,
    },
  },
  '@pkg/main/MCPServerHost': {
    getMCPServerHost: () => ({ getToolSession }),
  },
  '../../vault-broker': {
    getConfiguredCredentialBroker: jest.fn(),
    getLocalVaultPrincipalId:       jest.fn(),
    issueLocalBrokerContext,
    usesContainerVaultAuthority:    () => true,
  },
  '@pkg/runtime/capabilityToken': {
    deriveCapabilitySigningKey: jest.fn(),
    issueCapabilityToken:       jest.fn(),
    verifyCapabilityToken:      jest.fn(),
  },
  '@pkg/utils/paths': { default: { appHome: '/synthetic' } },
  electron:           undefined,
});

const { ChatCompletionsServer } = await import('../chatCompletionsServer');

function request(sessionToken?: string, endpoint = 'list_prs') {
  const body = {
    absolutePath: '/synthetic/repo',
    agentId:      'request-controlled-agent',
    threadId:     'request-controlled-thread',
    podId:        'request-controlled-pod',
    ...(endpoint.startsWith('git_') ? {} : { owner: 'merchantprotocol', repo: 'sulla-desktop' }),
  };
  return {
    params: { accountId: 'internal', slug: 'github', endpoint },
    body,
    header(name: string) {
      if (name === 'X-Sulla-Tool-Session') return sessionToken;
      if (name === 'X-Request-Id') return 'trusted-request';
      return undefined;
    },
    headers: {},
  } as any;
}

function response() {
  const res: any = {
    statusCode:    200,
    body:          undefined,
    writableEnded: false,
    status:        jest.fn((code: number) => { res.statusCode = code; return res }),
    json:          jest.fn((body: any) => { res.body = body; return res }),
    once:          jest.fn(),
    off:           jest.fn(),
  };
  return res;
}

it('binds each GitHub CLI call to verified session identity and fails closed without that authority', async() => {
  global.fetch = jest.fn(async() => ({ ok: false })) as any;
  const tools: any[] = [];
  createTool.mockImplementation(async(name) => {
    if (name === 'github_git_status' || name === 'github_git_push') throw new Error('not found');
    const tool = {
      name,
      metadata:         { category: 'github' },
      call:             jest.fn(async() => ({ executionContext: tool.executionContext })),
      setState:         jest.fn(),
      executionContext: undefined as any,
    };
    tools.push(tool);
    return tool;
  });
  getToolSession.mockImplementation(token => token === 'verified-session'
    ? { state: trustedState, executionContext: undefined }
    : null);
  issueLocalBrokerContext.mockImplementation(async input => ({
    v: 1, iss: 'sulla-desktop', aud: 'sulla-tools', sub: 'trusted-principal',
    agent_id: input.agentId, pod_id: input.podId, scopes: ['github/*'],
    thread_id: input.threadId, job_id: input.jobId, org_id: input.orgId,
    request_id: input.requestId, credential_scope: input.credentialScope,
    iat: now, exp: now + 300, jti: 'trusted-jti',
  }));
  const server = Object.create(ChatCompletionsServer.prototype) as any;

  for (let i = 0; i < 2; i++) {
    const res = response();
    await server.handleIntegrationCall(request('verified-session'), res);
    expect(res.statusCode).toBe(200);
  }

  expect(tools[0]).not.toBe(tools[1]);
  expect(getExecutionTarget).toHaveBeenCalled();
  expect(issueLocalBrokerContext).toHaveBeenCalledTimes(2);
  expect(issueLocalBrokerContext).toHaveBeenLastCalledWith(expect.objectContaining({
    agentId:         'trusted-agent',
    threadId:        'trusted-thread',
    podId:           'trusted-pod',
    jobId:           'trusted-job',
    orgId:           'trusted-org',
    requestId:       'trusted-request',
    credentialScope: { integration_id: 'github', account_id: 'trusted-account' },
  }));
  expect(issueLocalBrokerContext).not.toHaveBeenCalledWith(expect.objectContaining({ agentId: 'request-controlled-agent' }));
  expect(tools[0].executionContext).toEqual(expect.objectContaining({
    agent_id: 'trusted-agent', thread_id: 'trusted-thread', pod_id: 'trusted-pod',
  }));

  for (const [token, expectedError] of [
    [undefined, 'verified tool session'],
    ['expired-session', 'Expired tool session'],
  ] as const) {
    const res = response();
    await server.handleIntegrationCall(request(token), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain(expectedError);
  }

  getToolSession.mockReturnValueOnce({
    state: { metadata: { ...trustedState.metadata, allowedToolNames: ['read_file'] } },
    executionContext: undefined,
  });
  const denied = response();
  await server.handleIntegrationCall(request('verified-session'), denied);
  expect(denied.statusCode).toBe(403);
  expect(denied.body.error).toBe('Tool not allowed for this session');
  expect(tools.slice(2).every(tool => tool.call.mock.calls.length === 0)).toBe(true);

  getToolSession.mockReturnValueOnce({
    state: { metadata: { ...trustedState.metadata, podId: undefined, allowedToolNames: ['git_push'] } },
    executionContext: undefined,
  });
  const runtimeLookups = containerRuntimeForExecution.mock.calls.length;
  const push = response();
  await server.handleIntegrationCall(request('verified-session', 'git_push'), push);
  expect(push.statusCode).toBe(200);
  expect(issueLocalBrokerContext).toHaveBeenCalledTimes(3);
  expect(issueLocalBrokerContext).toHaveBeenLastCalledWith(expect.objectContaining({
    agentId: 'trusted-agent', podId: 'desktop:trusted-thread', threadId: 'trusted-thread',
  }));
  expect(containerRuntimeForExecution).toHaveBeenCalledTimes(runtimeLookups);
  expect(tools[tools.length - 1].executionContext).toEqual(expect.objectContaining({
    agent_id: 'trusted-agent', pod_id: 'desktop:trusted-thread', thread_id: 'trusted-thread',
  }));

  getToolSession.mockReturnValueOnce({
    state: { metadata: { ...trustedState.metadata, allowedToolNames: ['git_push'] } },
    executionContext: undefined,
  });
  containerRuntimeForExecution.mockReturnValueOnce({ podId: 'trusted-pod' } as any);
  const containerPush = response();
  await server.handleIntegrationCall(request('verified-session', 'git_push'), containerPush);
  expect(containerPush.statusCode).toBe(200);
  expect(containerRuntimeForExecution).toHaveBeenLastCalledWith(expect.objectContaining({
    agent_id: 'trusted-agent', pod_id: 'trusted-pod', thread_id: 'trusted-thread',
  }), 'agent-local');
  expect(withAgentContainerRuntime).toHaveBeenCalled();

  getToolSession.mockReturnValueOnce({
    state: { metadata: { ...trustedState.metadata, allowedToolNames: ['git_status'] } },
    executionContext: undefined,
  });
  const local = response();
  await server.handleIntegrationCall(request('verified-session', 'git_status'), local);
  expect(local.statusCode).toBe(200);
  expect(issueLocalBrokerContext).toHaveBeenCalledTimes(4);
  expect(tools[tools.length - 1].executionContext).toBeUndefined();
});
