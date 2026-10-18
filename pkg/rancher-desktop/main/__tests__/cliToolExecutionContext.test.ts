/** @jest-environment node */

import { expect, it, jest, beforeEach } from '@jest/globals';

import mockModules from '@pkg/utils/testUtils/mockModules';

const now = Math.floor(Date.now() / 1000);
const state = { metadata: { allowedToolNames: ['git_status'], threadId: 'thread' } };
const sessionContext = {
  v: 1, iss: 'sulla-desktop', aud: 'sulla-tools', sub: 'principal',
  agent_id: 'worker', pod_id: 'sulla-agent-job-0', thread_id: 'thread', job_id: 'job',
  scopes: ['github/git_status'], iat: now, exp: now + 300, jti: 'session-jti', request_id: 'session-request',
} as const;
const getToolSession = jest.fn<(token: string) => any>();
const createTool = jest.fn<(name: string) => Promise<any>>();
const getExecutionTarget = jest.fn<(name: string) => string | undefined>();
const callTool = jest.fn<() => Promise<any>>();
const containerRuntimeForExecution = jest.fn<(...args: any[]) => any>();
const withAgentContainerRuntime = jest.fn((_runtime: any, action: () => any) => action());
const issueLocalBrokerContext = jest.fn<(input: any) => Promise<any>>();
const verifyCapabilityToken = jest.fn<(...args: any[]) => Promise<any>>();
const issueCapabilityToken = jest.fn<(...args: any[]) => string>(() => 'forwarded-capability');

mockModules({
  '@pkg/agent/database/models/SullaSettingsModel': { SullaSettingsModel: { get: jest.fn(), set: jest.fn() } },
  '@pkg/agent/services/AgentContainerRuntimeRegistry': { containerRuntimeForExecution, withAgentContainerRuntime },
  '@pkg/agent/services/GraphRegistry': { GraphRegistry: {}, nextThreadId: jest.fn(), nextMessageId: jest.fn() },
  '@pkg/agent/services/IntegrationService': { getIntegrationService: () => ({ getActiveAccountId: async() => 'active-account' }) },
  '@pkg/agent/services/WebSocketClientService': { getWebSocketClientService: () => ({ connect: jest.fn(), onMessage: jest.fn(), send: jest.fn() }) },
  '@pkg/agent/tools/registry': { toolRegistry: {
    createTool,
    findSimilarToolNames: jest.fn(() => []),
    getExecutionTarget,
  } },
  '@pkg/main/MCPServerHost': { getMCPServerHost: () => ({ getToolSession }) },
  '../../vault-broker': {
    getConfiguredCredentialBroker: jest.fn(), getLocalVaultPrincipalId: jest.fn(), issueLocalBrokerContext,
    usesContainerVaultAuthority: () => true,
  },
  '@pkg/runtime/capabilityToken': {
    deriveCapabilitySigningKey: jest.fn(() => 'signing-key'), issueCapabilityToken,
    verifyCapabilityToken,
  },
  '@pkg/utils/paths': { default: { appHome: '/synthetic' } },
  electron: undefined,
});

const { ChatCompletionsServer } = await import('../chatCompletionsServer');

function request(session: string | null = 'verified-session', bearer = 'signed-capability', endpoint = 'git_status') {
  return {
    params: { accountId: 'internal', slug: 'github', endpoint },
    body: { absolutePath: '/synthetic/repo', agentId: 'request-controlled' },
    headers: { authorization: `Bearer ${ bearer }` },
    header(name: string) {
      if (name === 'X-Sulla-Tool-Session') return session ?? undefined;
      if (name === 'X-Request-Id') return 'request';
      return undefined;
    },
  } as any;
}

function response() {
  const res: any = {
    statusCode: 200, body: undefined, writableEnded: false,
    status: jest.fn((code: number) => { res.statusCode = code; return res }),
    json: jest.fn((body: any) => { res.body = body; return res }),
    type: jest.fn(() => res), send: jest.fn((body: any) => { res.body = body; return res }),
    once: jest.fn(), off: jest.fn(),
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(async() => { throw new Error('catalog unavailable') }) as any;
  getToolSession.mockReturnValue({ state, executionContext: sessionContext });
  verifyCapabilityToken.mockResolvedValue({ ...sessionContext, jti: 'bearer-jti' });
  containerRuntimeForExecution.mockReturnValue({ podId: sessionContext.pod_id });
  getExecutionTarget.mockImplementation(name => name === 'github_list_prs' ? 'catalog' : 'agent-local');
  issueLocalBrokerContext.mockResolvedValue({
    ...sessionContext, agent_id: 'desktop-cli', pod_id: 'desktop-main', scopes: [],
    credential_scope: { integration_id: 'github', account_id: 'active-account' },
  });
  callTool.mockImplementation(async function(this: any) { return { context: this.executionContext } });
  createTool.mockImplementation(async(name: string) => {
    if (name === 'github_git_status') throw new Error('not found');
    return {
      name, metadata: { category: 'github' }, executionContext: undefined, setState: jest.fn(),
      call: callTool,
    };
  });
});

it('dispatches a verified session with its authenticated identity and container runtime', async() => {
  const server = Object.create(ChatCompletionsServer.prototype) as any;
  server.apiToken = 'desktop-secret';
  const res = response();

  await server.handleIntegrationCall(request(), res);

  expect(res.statusCode).toBe(200);
  expect(res.body.result.context).toEqual(expect.objectContaining({ sub: 'principal', pod_id: 'sulla-agent-job-0' }));
  expect(containerRuntimeForExecution).toHaveBeenCalled();
  expect(withAgentContainerRuntime).toHaveBeenCalled();
});

it('rejects a mismatched bearer identity before dispatch', async() => {
  verifyCapabilityToken.mockResolvedValueOnce({ ...sessionContext, sub: 'other-principal' });
  const server = Object.create(ChatCompletionsServer.prototype) as any;
  server.apiToken = 'desktop-secret';
  const res = response();

  await server.handleIntegrationCall(request(), res);

  expect(res.statusCode).toBe(403);
  expect(callTool).not.toHaveBeenCalled();
  expect(containerRuntimeForExecution).not.toHaveBeenCalled();
});

it.each([
  ['expired execution context', { state, executionContext: { ...sessionContext, exp: now - 1 } }, 'signed-capability', 'git_status', 'Expired tool execution context'],
  ['disallowed tool', { state: { metadata: { allowedToolNames: ['read_file'] } }, executionContext: sessionContext }, 'signed-capability', 'git_status', 'Tool not allowed for this session'],
  ['missing execution context', { state: { metadata: { allowedToolNames: ['github_list_prs'] } } }, 'desktop-secret', 'list_prs', 'Tool session is missing verified execution context'],
])('fails closed for a %s session', async(_case, resolvedSession, bearer, endpoint, expected) => {
  getToolSession.mockReturnValue(resolvedSession);
  const server = Object.create(ChatCompletionsServer.prototype) as any;
  server.apiToken = 'desktop-secret';
  const res = response();

  await server.handleIntegrationCall(request('verified-session', bearer, endpoint), res);

  expect(res.statusCode).toBe(403);
  expect(res.body.error).toBe(expected);
  expect(callTool).not.toHaveBeenCalled();
});

it.each([
  ['session', { integration_id: 'github', account_id: 'active-account', repository: 'owner/repo' }, { integration_id: 'github', account_id: 'active-account' }],
  ['bearer', { integration_id: 'github', account_id: 'active-account' }, { integration_id: 'github', account_id: 'active-account', repository: 'owner/repo' }],
])('does not broaden a %s repository scope when forwarding', async(_source, sessionScope, bearerScope) => {
  getToolSession.mockReturnValue({ state: { metadata: { allowedToolNames: ['github_list_prs'] } }, executionContext: { ...sessionContext, credential_scope: sessionScope } });
  verifyCapabilityToken.mockResolvedValueOnce({ ...sessionContext, credential_scope: bearerScope });
  global.fetch = jest.fn(async() => ({
    ok: true, status: 200,
    text: async() => JSON.stringify({ success: true }),
    headers: { get: () => 'application/json' },
  })) as any;
  const server = Object.create(ChatCompletionsServer.prototype) as any;
  server.apiToken = 'desktop-secret';

  await server.handleIntegrationCall(request('verified-session', 'signed-capability', 'list_prs'), response());

  expect(issueCapabilityToken).toHaveBeenCalledWith(expect.objectContaining({
    credential_scope: { integration_id: 'github', account_id: 'active-account', repository: 'owner/repo' },
  }), 'signing-key');
});

it('keeps authenticated Desktop CLI execution off the container runtime', async() => {
  getToolSession.mockReturnValue(null);
  const server = Object.create(ChatCompletionsServer.prototype) as any;
  server.apiToken = 'desktop-secret';
  const res = response();

  await server.handleIntegrationCall(request(null, 'desktop-secret', 'list_prs'), res);

  expect(res.statusCode).toBe(200);
  expect(res.body.result.context).toEqual(expect.objectContaining({ agent_id: 'desktop-cli', pod_id: 'desktop-main' }));
  expect(containerRuntimeForExecution).not.toHaveBeenCalled();
});

it('keeps local git inspection independent of vault authority', async() => {
  getToolSession.mockReturnValue(null);
  const server = Object.create(ChatCompletionsServer.prototype) as any;
  server.apiToken = 'desktop-secret';
  const res = response();

  await server.handleIntegrationCall(request(null, 'desktop-secret', 'git_status'), res);

  expect(res.statusCode).toBe(200);
  expect(issueLocalBrokerContext).not.toHaveBeenCalled();
  expect(res.body.result.context).toBeUndefined();
});
