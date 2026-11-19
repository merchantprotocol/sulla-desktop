// SPDX-License-Identifier: GPL-2.0-or-later
// The graph's model resolution must hand its run Stop handle to a worker route catalog wait.
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BaseNode } from '../../../nodes/BaseNode';
import { AbortService } from '../../../services/AbortService';
import { agentDefinitionService } from '../../../services/AgentDefinitionService';
import { workerModelRouting } from '../../../services/WorkerModelRouting';

import type { BaseThreadState, NodeResult } from '../../../nodes/Graph';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

class RouteProbeNode extends BaseNode {
  constructor() { super('route-probe', 'Route probe') }
  async execute(state: BaseThreadState): Promise<NodeResult<BaseThreadState>> { return { state, decision: { type: 'end' } } as any }
  resolve(state: BaseThreadState) { return this.resolveLoopProvider(state) }
}

const route = { version: 1, slug: 'luna', agentId: 'luna-id', revision: 1, selected: 0, candidates: [{ provider: 'codex', model: 'gpt-6-luna' }] };
const stateWith = (abort: unknown): BaseThreadState => ({ metadata: { threadId: 't', agentId: 'luna', options: { abort }, workerModelRoute: structuredClone(route) }, messages: [] }) as any;

afterEach(() => { vi.restoreAllMocks() });

describe('graph model resolution Stop propagation for worker routes', () => {
  it.each([
    ['an AbortService run handle', () => { const handle = new AbortService(); return { handle, signal: handle.signal, stop: () => handle.abort() } }],
    ['a raw AbortSignal run handle', () => { const controller = new AbortController(); return { handle: controller.signal, signal: controller.signal, stop: () => controller.abort() } }],
  ])('ends the catalog wait when %s is stopped', async(_label, make) => {
    const run = make();
    let received: AbortSignal | undefined;
    vi.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue({ id: 'luna-id', slug: 'luna' } as any);
    vi.spyOn(workerModelRouting, 'resolveRoute').mockImplementation((_route, signal) => {
      received = signal;
      // Behaves like a catalog outage: settles only when the run is stopped.
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true }));
    });
    const resolving = new RouteProbeNode().resolve(stateWith(run.handle));
    await vi.waitFor(() => expect(received).toBe(run.signal));
    run.stop();
    await expect(resolving).rejects.toMatchObject({ name: 'AbortError' });
  });
});
