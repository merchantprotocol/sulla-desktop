/** @jest-environment node */
import { jest } from '@jest/globals';
import mockModules from '@pkg/utils/testUtils/mockModules';
const rows = new Map<string, any>();
const policies = new Set<string>();
let failWrite = false;
const query = jest.fn(async(sql: string, args: any[] = []): Promise<any[]> => {
  if (failWrite && sql.startsWith('UPDATE')) throw new Error('Database unavailable');
  if (sql.startsWith('INSERT INTO human')) rows.set(args[0], { session: args[1], status: args[2], record: JSON.parse(args[3]) });
  if (sql.includes('SELECT record')) return [...rows.values()].map(r => ({ record: r.record }));
  if (sql.includes("session_id <>")) {
    for (const row of rows.values()) if (['pending', 'deferred'].includes(row.status) && (row.session !== args[0] || row.record.expiresAt <= args[1])) { row.status = 'expired'; row.record.status = 'expired'; }
  } else if (sql.startsWith('UPDATE')) {
    const row = rows.get(args[0]);
    if (!row || !['pending', 'deferred'].includes(row.status)) return [];
    row.status = args[1] || 'expired';
    row.record = args[2] ? JSON.parse(args[2]) : { ...row.record, status: 'expired' };
    return [{ id: args[0] }];
  }
  if (sql.startsWith('INSERT INTO tool')) policies.add(args[0]);
  if (sql.startsWith('DELETE FROM tool')) policies.delete(args[0]);
  if (sql.includes('SELECT tool_name')) return [...policies].filter(x => !args.length || x === args[0]).map(tool_name => ({ tool_name }));
  return [];
});
mockModules({ '@pkg/agent/database/PostgresClient': { postgresClient: { query } } });
const { DecisionService } = await import('../DecisionService');
const input = (conversationId = 'original-a') => ({ kind: 'approval' as const, title: 'Publish reviewed change', conversationId, channel: 'mobile-relay' });
beforeEach(() => { rows.clear(); policies.clear(); failWrite = false; jest.useFakeTimers(); });
afterEach(() => jest.useRealTimers());
test('approval resumes only its original caller; duplicate and wrong-conversation answers fail closed', async() => {
  const service = new DecisionService();
  const a = await service.request(input());
  const b = await service.request(input('original-b'));
  const response = { id: a.record.id, conversationId: 'original-a', action: 'approved' as const };
  expect((await service.resolve({ ...response, conversationId: 'original-b' })).settled).toBe(false);
  const receipts = await Promise.all([service.resolve(response), service.resolve(response)]);
  expect(receipts.filter(r => r.settled)).toHaveLength(1);
  expect(await a.result).toEqual({ status: 'approved', answers: [] });
  expect((await service.list()).find(r => r.id === b.record.id)?.status).toBe('pending');
  await service.expire(b.record.id);
});
test('defer keeps same request and caller waiting; eventual denial does not authorize execution', async() => {
  const service = new DecisionService(); const request = await service.request(input());
  await service.resolve({ id: request.record.id, conversationId: 'original-a', action: 'deferred' });
  expect((await service.list())[0].status).toBe('deferred');
  await service.resolve({ id: request.record.id, conversationId: 'original-a', action: 'denied' });
  expect((await request.result).status).toBe('denied');
});
test('timeout and process restart cannot replay a pending action', async() => {
  const service = new DecisionService(); const request = await service.request(input(), 100);
  await jest.advanceTimersByTimeAsync(101);
  expect((await request.result).status).toBe('expired');
  expect((await service.resolve({ id: request.record.id, conversationId: 'original-a', action: 'approved' })).settled).toBe(false);
  const orphan = await service.request(input());
  const restarted = new DecisionService();
  expect((await restarted.list()).every(r => r.status === 'expired')).toBe(true);
  expect((await restarted.resolve({ id: orphan.record.id, conversationId: 'original-a', action: 'approved' })).settled).toBe(false);
  await service.expire(orphan.record.id);
});
test('failed persistence never releases the waiting action', async() => {
  const service = new DecisionService(); const request = await service.request(input());
  failWrite = true;
  await expect(service.resolve({ id: request.record.id, conversationId: 'original-a', action: 'approved' })).rejects.toThrow('Database unavailable');
  failWrite = false;
  expect((await service.list())[0].status).toBe('pending');
  await service.expire(request.record.id);
});
test('questions validate cardinality, retain original question, and return user answer to original caller', async() => {
  const service = new DecisionService();
  const request = await service.request({ ...input(), kind: 'question', questions: [{ question: 'Which option?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
  const response = { id: request.record.id, conversationId: 'original-a', action: 'answered' as const };
  await expect(service.resolve({ ...response, answers: [] })).rejects.toThrow('Answer every question');
  await service.resolve({ ...response, answers: [{ question: 'forged', selected: ['Other choice'] }] });
  expect((await request.result).answers).toEqual([{ question: 'Which option?', selected: ['Other choice'] }]);
});
test('missing original conversation fails before creating a request', async() => {
  await expect(new DecisionService().request(input(''))).rejects.toThrow('original conversation');
  expect(rows.size).toBe(0);
});
test('policy updates apply only to exact selected tool', async() => {
  const service = new DecisionService();
  await service.setPolicy('git_push', true);
  expect(await service.requiresApproval('git_push')).toBe(true);
  expect(await service.requiresApproval('git_status')).toBe(false);
  await service.setPolicy('git_push', false);
  expect(await service.policies()).toEqual([]);
});
test('stopping the original caller expires its request rather than running later', async() => {
  const service = new DecisionService(); const controller = new AbortController();
  const request = await service.request(input(), 1000, controller.signal);
  controller.abort();
  expect((await request.result).status).toBe('expired');
  expect((await service.resolve({ id: request.record.id, conversationId: 'original-a', action: 'approved' })).settled).toBe(false);
});
