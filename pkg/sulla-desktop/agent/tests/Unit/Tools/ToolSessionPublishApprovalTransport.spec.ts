// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { ToolSessionChatTransport } from '../../../tools/ToolSessionChatTransport';

describe('ToolSessionChatTransport for Files publish approvals', () => {
  it('routes a CLI approval to the verified session thread and its WebSocket channel', async() => {
    // risk: approval routing — a Claude Code `sulla` CLI call must land in the chat that created its DecisionService record.
    const bus = { send: vi.fn(async() => true) };
    const tool: any = { name: 'files_request_publish', metadata: { category: 'files' } };
    const state = { metadata: { threadId: 'verified-thread', wsChannel: 'verified-channel' } } as any;

    new ToolSessionChatTransport(async() => bus).attach(tool, state);

    expect(tool.sendChatMessage).toBeTypeOf('function');
    await tool.sendChatMessage('', 'tool_approval', { toolApproval: { approvalId: 'decision-9' } });
    expect(bus.send).toHaveBeenCalledWith('verified-channel', {
      type: 'assistant_message',
      data: expect.objectContaining({ kind: 'tool_approval', thread_id: 'verified-thread', toolApproval: { approvalId: 'decision-9' } }),
    });
  });

  it('routes other DecisionService approval cards but keeps generic CLI messages silent', async() => {
    // risk: user consent — policy-gated CLI tools must show their approval in the exact originating conversation.
    const bus = { send: vi.fn(async() => true) };
    const tool: any = { name: 'create_issue', metadata: { category: 'github' } };
    const state = { metadata: { threadId: 'verified-thread', wsChannel: 'verified-channel' } } as any;

    new ToolSessionChatTransport(async() => bus).attach(tool, state);

    await expect(tool.sendChatMessage('internal progress', 'progress')).resolves.toBe(false);
    await tool.sendChatMessage('Review the tool call.', 'tool_approval', {
      toolApproval: { approvalId: 'decision-github', reason: 'Create an issue', command: 'create_issue' },
    });
    expect(bus.send).toHaveBeenCalledTimes(1);
    expect(bus.send).toHaveBeenCalledWith('verified-channel', {
      type: 'assistant_message',
      data: expect.objectContaining({ kind: 'tool_approval', thread_id: 'verified-thread', toolApproval: { approvalId: 'decision-github', reason: 'Create an issue', command: 'create_issue' } }),
    });
  });
});
