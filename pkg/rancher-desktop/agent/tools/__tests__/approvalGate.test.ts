/** @jest-environment node */
import { jest } from '@jest/globals';
import mockModules from '@pkg/utils/testUtils/mockModules';
let registered: () => void;
let finish: (value: any) => void;
const requiresApproval = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
const request = jest.fn(async(input: any) => {
  if (!input.conversationId) throw new Error('Original conversation required');
  const result = new Promise(resolve => { finish = resolve; });
  registered?.();
  return { record: { id: 'one-request', title: input.title }, result };
});
mockModules({ '@pkg/agent/services/DecisionService': { decisionService: { requiresApproval, request } } });
const { BaseTool } = await import('../base');
class TestTool extends BaseTool {
  name = 'test_change'; description = 'Change a thing';
  schemaDef = { target: { type: 'object' as const } };
  executions: unknown[] = [];
  protected async _validatedCall(input: any) { this.executions.push(input); return { successBoolean: true, responseString: 'Executed' }; }
}
async function parked(tool: TestTool, input: any) {
  const ready = new Promise<void>(resolve => { registered = resolve; });
  const pending = tool.call(input);
  await ready;
  return { pending };
}
beforeEach(() => { jest.clearAllMocks(); requiresApproval.mockResolvedValue(true); });
test('does not execute until approval and binds the immutable input to original conversation', async() => {
  const tool = new TestTool(); tool.setState({ metadata: { threadId: 'original', wsChannel: 'mobile-relay' } });
  const input = { target: { branch: 'reviewed' } };
  const { pending } = await parked(tool, input);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'original', channel: 'mobile-relay', toolName: 'test_change' }), undefined, undefined);
  input.target.branch = 'changed-while-waiting';
  expect(tool.executions).toHaveLength(0);
  finish({ status: 'approved' });
  expect((await pending).success).toBe(true);
  expect(tool.executions).toEqual([{ target: { branch: 'reviewed' } }]);
});
test.each(['denied', 'expired'])('%s never executes', async status => {
  const tool = new TestTool(); tool.setState({ metadata: { threadId: 'original', wsChannel: 'mobile-relay' } });
  const { pending } = await parked(tool, { target: {} }); finish({ status });
  expect((await pending).success).toBe(false); expect(tool.executions).toHaveLength(0);
});
test('unbound CLI calls fail closed and ungated calls still work', async() => {
  const tool = new TestTool();
  expect((await tool.call({ target: {} })).success).toBe(false);
  expect(tool.executions).toHaveLength(0);
  requiresApproval.mockResolvedValue(false);
  expect((await tool.call({ target: {} })).success).toBe(true);
});
