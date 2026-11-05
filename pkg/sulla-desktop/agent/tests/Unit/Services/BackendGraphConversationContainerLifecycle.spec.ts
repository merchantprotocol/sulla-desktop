// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import type { AgentContainerLifecycle } from '@pkg/agent/services/AgentContainerLauncher';
import { ConversationContainerSettlementService } from '@pkg/agent/services/ConversationContainerSettlementService';

describe('conversation container settlement', () => {
  it('re-arms the idle close after a finished manager turn', async() => {
    // risk: reusing a conversation clears its only timer and leaks the container forever
    const service = new ConversationContainerSettlementService({ isTerminalDelegatedThread: async() => false });
    const record = { lifecycle: { close: vi.fn() } as unknown as AgentContainerLifecycle, idleTimer: 7 as unknown as ReturnType<typeof setTimeout> };
    const clear = vi.fn();
    const rearm = vi.fn(() => 9 as unknown as ReturnType<typeof setTimeout>);
    expect(await service.settle('thread-a', record, clear, vi.fn(), rearm)).toBe('rearmed');
    expect(clear).toHaveBeenCalledWith(7);
    expect(record.idleTimer).toBe(9);
    expect(record.lifecycle.close).not.toHaveBeenCalled();
  });

  it('closes and forgets a manager container as soon as its job is terminal', async() => {
    // risk: completed manager session containers remain up beyond their job end
    const service = new ConversationContainerSettlementService({ isTerminalDelegatedThread: async() => true });
    const record = { lifecycle: { close: vi.fn().mockResolvedValue(undefined) } as unknown as AgentContainerLifecycle, idleTimer: 8 as unknown as ReturnType<typeof setTimeout> };
    const remove = vi.fn();
    expect(await service.settle('thread-done', record, vi.fn(), remove, vi.fn())).toBe('closed');
    expect(remove).toHaveBeenCalledOnce();
    expect(record.lifecycle.close).toHaveBeenCalledWith('agent-job-terminal', 'BackendGraphWebSocketService.settleConversationContainer');
  });
});
