// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { AgentActionController } from '@pkg/services/agentState/AgentActionController';
import { AgentStateClient, type AgentStateTransport, type AgentStateWindow } from '@pkg/services/agentState/AgentStateClient';
import { AgentTreeBuilder } from '@pkg/services/agentState/AgentTreeBuilder';
import type { AgentActionResult, AgentStateRow, AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';

class FakeTransport implements AgentStateTransport {
  snapshot:         AgentStateSnapshot;
  result:           AgentActionResult = { ok: true };
  private listener: ((event: unknown, snapshot: AgentStateSnapshot) => void) | null = null;
  constructor(snapshot: AgentStateSnapshot) { this.snapshot = snapshot }
  invoke(channel: string): Promise<unknown> { return Promise.resolve(channel === 'agents:state-snapshot' ? this.snapshot : this.result) }
  on(_channel: string, listener: (event: unknown, snapshot: AgentStateSnapshot) => void): unknown { this.listener = listener; return undefined }
  removeListener(): unknown { this.listener = null; return undefined }
  push(snapshot: AgentStateSnapshot): void { this.listener?.({}, snapshot) }
}
class FakeHost implements AgentStateWindow {
  document = { visibilityState: 'visible', addEventListener: (_type: string, _listener: () => void) => {}, removeEventListener: (_type: string, _listener: () => void) => {} };
  addEventListener(_type: string, _listener: () => void): void {}
  removeEventListener(_type: string, _listener: () => void): void {}
  setInterval(_handler: () => void, _ms: number): ReturnType<typeof setInterval> { return 1 as unknown as ReturnType<typeof setInterval> }
  clearInterval(_handle: ReturnType<typeof setInterval>): void {}
}
class RowFactory {
  create(key: string, rootThreadId = 'root', parentKey: string | null = null): AgentStateRow {
    const [jobId, task = '0'] = key.split(':'); const [parentJobId, parentTask = ''] = parentKey?.split(':') ?? [];
    return { key, jobId, taskIndex: Number(task), parentJobId: parentJobId || null, parentTaskIndex: parentJobId ? Number(parentTask) : null, rootThreadId, threadId: `thread-${ key }`, depth: parentKey ? 1 : 0, agentId: 'codex-sol-worker', label: key, visibility: 'hidden', state: 'working', stateReason: null, waitingOnChildren: 0, startedAt: '2026-11-04T20:00:00.000Z', endedAt: null, lastCheckinAt: null, lastCheckinSummary: null, canMessage: true, canStop: true, canOpen: true };
  }
}
const snapshot = (version: number, rows: AgentStateRow[]): AgentStateSnapshot => ({ version, generatedAt: '2026-11-04T20:00:00.000Z', rows });

describe('AgentTreeBuilder', () => {
  it('nests every descendant, excludes another chat, and keeps an orphan visible', () => {
    // risk: orchestrator visibility
    const factory = new RowFactory(); const manager = factory.create('manager:0'); const worker = factory.create('worker:0', 'root', manager.key); const grand = factory.create('grand:0', 'root', worker.key); grand.depth = 2; const orphan = factory.create('orphan:0', 'root', 'dropped:0'); const other = factory.create('other:0', 'other-root');
    const tree = new AgentTreeBuilder([grand, other, orphan, worker, manager]).forThread('root');
    expect(tree.map(node => node.row.key)).toEqual(['manager:0', 'orphan:0']);
    expect(tree[0].children[0].row.key).toBe('worker:0');
    expect(tree[0].children[0].children[0].row.key).toBe('grand:0');
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children[0].depth).toBe(2);
    expect(new AgentTreeBuilder([grand, other, orphan, worker, manager]).flatten(tree).some(node => node.row.key === other.key)).toBe(false);
  });

  it('keeps malformed cycles visible once without recursing forever', () => {
    // risk: orchestrator visibility
    const factory = new RowFactory();
    const first = factory.create('first:0', 'root', 'second:0');
    const second = factory.create('second:0', 'root', 'first:0');
    const builder = new AgentTreeBuilder([first, second]);
    const flattened = builder.flatten(builder.forThread('root'));
    expect(flattened.map(node => node.row.key).sort()).toEqual(['first:0', 'second:0']);
  });
});

describe('AgentStateClient', () => {
  it('applies pushes, ignores older versions, and resync restores authoritative rows after a drop', async() => {
    // risk: stale operational state
    const factory = new RowFactory(); const transport = new FakeTransport(snapshot(1, [factory.create('first:0')])); const client = new AgentStateClient(transport, new FakeHost());
    await client.start(); transport.push(snapshot(3, [factory.create('pushed:0')])); transport.push(snapshot(3, [factory.create('equal:0')])); transport.push(snapshot(2, [factory.create('old:0')]));
    expect(client.snapshot.value.rows.map(row => row.key)).toEqual(['pushed:0']);
    transport.snapshot = snapshot(4, [factory.create('restored:0')]); await client.resync();
    expect(client.snapshot.value.rows.map(row => row.key)).toEqual(['restored:0']);
    client.stop();
  });
});

describe('AgentActionController', () => {
  it('gates message actions and applies a stale action snapshot without an error', async() => {
    // risk: actions sent to ended agents
    const factory = new RowFactory(); const row = factory.create('target:0'); row.canMessage = false; const transport = new FakeTransport(snapshot(1, [row])); const client = new AgentStateClient(transport, new FakeHost()); await client.start(); const controller = new AgentActionController(transport, client);
    expect(controller.canMessage(row)).toBe(false);
    transport.result = { ok: false, stale: true, snapshot: snapshot(2, []) };
    const result = await controller.message({ ...row, canMessage: true }, 'continue');
    expect(result.stale).toBe(true); expect(result.error).toBeUndefined(); expect(client.snapshot.value.rows).toEqual([]);
    expect(client.snapshot.value.rows.some(current => current.canMessage)).toBe(false);
    client.stop();
  });
});
