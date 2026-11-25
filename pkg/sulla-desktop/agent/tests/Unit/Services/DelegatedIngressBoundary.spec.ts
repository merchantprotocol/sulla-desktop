// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentJobLifecycle } from '../../../services/AgentJobLifecycleService';
import { BackendGraphWebSocketService } from '../../../services/BackendGraphWebSocketService';
import { GraphRegistry } from '../../../services/GraphRegistry';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../services/AgentExecutionReadiness', () => ({
  waitForAutomaticAgentExecution: () => Promise.resolve(),
  agentExecutionReadiness:        { active: true, draining: false },
}));

const thread = 'worker';
const state = (): any => ({ messages: [], metadata: { delegatedRunActive: true } });
function fixture() {
  const service = Object.create(BackendGraphWebSocketService.prototype);
  service.recoveryAbort = new AbortController();
  service.activeAborts = new Map();
  service.dispatchToAgent = vi.fn().mockResolvedValue('accepted');
  return service;
}
const message = (backend: any, metadata = {}) => backend.handleChannelMessage('desktop', 'sulla-desktop', {
  type: 'user_message', data: { threadId: thread, content: 'follow-up', metadata },
});
afterEach(() => vi.restoreAllMocks());

describe('delegated input admission', () => {
  it('dispatches renderer input normally during terminal persistence on an evicted thread', async() => {
    const backend = fixture();
    const closing = state();
    vi.spyOn(GraphRegistry, 'get').mockReturnValue(null);
    let persist!: () => void;
    const barrier = new Promise<void>(resolve => { persist = resolve });
    const write = agentJobLifecycle.withRunner(thread, closing, () => {
      agentJobLifecycle.closeInput(thread, closing);
      return barrier;
    });
    try {
      expect(agentJobLifecycle.hasRunner(thread)).toBe(true);
      await message(backend);
      expect(backend.dispatchToAgent).toHaveBeenCalledOnce();
      expect(closing.messages).toEqual([]);
    } finally { persist(); await write }
  });
});
