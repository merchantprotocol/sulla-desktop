/** @jest-environment node */
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const query = jest.fn<any>();
const queryOne = jest.fn<any>();
const transaction = jest.fn<any>();
const clientQuery = jest.fn<any>();
const send = jest.fn<any>();
const webContentsSend = jest.fn<any>();

jest.unstable_mockModule('../../database/PostgresClient', () => ({
  postgresClient: { query, queryOne, transaction },
}));
jest.unstable_mockModule('../GraphRegistry', () => ({ nextThreadId: () => 'thread_child' }));
jest.unstable_mockModule('../ChatAgentRouting', () => ({
  resolveRoutableAgent: async(id: string) => ({ agentId: id, graphAgentId: id, name: id === 'parent' ? 'Parent' : 'Child' }),
}));
jest.unstable_mockModule('../WebSocketClientService', () => ({
  getWebSocketClientService: () => ({ send }),
}));
jest.unstable_mockModule('@pkg/window', () => ({
  getWindow: () => ({
    webContents: { send: webContentsSend, isLoading: () => false, once: jest.fn() },
  }),
}));

let AgentTabContractService: typeof import('../AgentTabContractService').AgentTabContractService;
let UI_TEST_ISSUES_SCHEMA: Record<string, unknown>;

beforeAll(async() => {
  ({ AgentTabContractService, UI_TEST_ISSUES_SCHEMA } = await import('../AgentTabContractService'));
});

beforeEach(() => {
  jest.clearAllMocks();
  transaction.mockImplementation((callback: any) => callback({ query: clientQuery }));
  send.mockResolvedValue(true);
  query.mockResolvedValue([]);
});

describe('agent-tab launch guardrails', () => {
  it('rejects a launch below a depth-two child before inserting', async() => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ depth: 2 }] });
    await expect(new AgentTabContractService().launch({
      parentThreadId: 'grandchild', parentChannel: 'sulla-desktop', parentAgentId: 'parent',
      agentId: 'child', brief: 'work',
    })).rejects.toThrow('depth limit');
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO agent_tab_contracts'))).toBe(false);
  });

  it('rejects a sixth open child contract before inserting', async() => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '5' }] });
    await expect(new AgentTabContractService().launch({
      parentThreadId: 'parent-thread', parentChannel: 'sulla-desktop', parentAgentId: 'parent',
      agentId: 'child', brief: 'work',
    })).rejects.toThrow('5 open child contracts');
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO agent_tab_contracts'))).toBe(false);
  });
});

describe('contract return validation', () => {
  const makeRow = () => ({
    id: 'contract-1', parent_thread_id: 'parent-thread', parent_channel: 'sulla-desktop', parent_agent_id: 'parent',
    child_thread_id: 'child-thread', child_agent_id: 'child', title: 'UI test', brief: 'test',
    contract_spec: { name: 'ui-test-issues', schema: UI_TEST_ISSUES_SCHEMA },
    status: 'open', result: null, depth: 1, created_at: 'now', returned_at: null,
  } as any);

  it('fails closed when another thread tries to return the contract', async() => {
    const row = makeRow();
    queryOne.mockResolvedValueOnce(row);
    await expect(new AgentTabContractService().returnContract('wrong-thread', row.id, {})).rejects.toThrow('owns this contract');
    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports schema mismatch without marking the contract returned', async() => {
    const row = makeRow();
    queryOne.mockResolvedValueOnce(row);
    await expect(new AgentTabContractService().returnContract('child-thread', row.id, {
      summary: { pass: 1, fail: 0, blocked: 0 }, issues: [],
    })).rejects.toThrow('does not match');
    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('atomically records a valid result and wakes the parent through inject_message', async() => {
    const row = makeRow();
    const result = { summary: { pass: 2, fail: 0, blocked: 0, notRun: 0 }, issues: [] };
    queryOne.mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, status: 'returned', result });
    await expect(new AgentTabContractService().returnContract('child-thread', row.id, result)).resolves.toMatchObject({ status: 'returned' });
    expect(String(queryOne.mock.calls[1][0])).toContain("status = 'open'");
    expect(send.mock.calls.some((call) => {
      const [channel, message] = call as [string, any];
      return channel === 'sulla-desktop' && message.type === 'inject_message' && message.data.threadId === 'parent-thread';
    })).toBe(true);
  });
});
