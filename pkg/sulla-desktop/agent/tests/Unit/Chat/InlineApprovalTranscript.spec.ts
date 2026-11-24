// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { createMessageDispatcher } from '../../../database/models/MessageDispatcher';
import { PersonaAdapter } from '../../../../pages/chat/services/PersonaAdapter';

describe('inline approval transcript persistence', () => {
  it('persists the decision id, title and expiry once when a tool_approval event is replayed', () => {
    // risk: approval routing — reloads and WS replays must retain the exact decision and its expiry without duplicate cards.
    const dispatcher = createMessageDispatcher();
    const messages: any[] = [];
    const ctx: any = { messages, graphRunning: { value: true }, registry: { setLoading: vi.fn() } };
    const expiresAt = Date.now() + 30 * 60_000;
    const message = {
      type: 'assistant_message',
      data: {
        content: '', role: 'assistant', kind: 'tool_approval', thread_id: 'chat-thread', timestamp: 123,
        toolApproval: {
          approvalId: 'decision-1', title: "Activate agent 'coding-manager' v1.0.0?", expiresAt,
          reason: 'Publish this Files draft.', command: 'Files draft publication', origin: { kind: 'files_publish' },
        },
      },
    } as any;

    dispatcher.dispatch(ctx, 'sulla-desktop', 'chat-thread', message);
    dispatcher.dispatch(ctx, 'sulla-desktop', 'chat-thread', message);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: 'tool_approval', threadId: 'chat-thread',
      toolApproval: { approvalId: 'decision-1', title: "Activate agent 'coding-manager' v1.0.0?", expiresAt, origin: { kind: 'files_publish' } },
    });
  });

  it('rebuilds the same approval card from the persisted backend message after reload', () => {
    // risk: user consent — a restored transcript must not lose the approval label or deadline.
    const adapter = Object.create(PersonaAdapter.prototype) as any;
    adapter.firstSeenAt = new Map();
    adapter.decisionStatus = new Map([['decision-1', 'pending']]);
    const expiresAt = Date.now() + 30 * 60_000;

    const restored = adapter.mapBackendMessage({
      id: '123_ws_tool_approval_decision-1', role: 'assistant', kind: 'tool_approval', content: '',
      toolApproval: {
        approvalId: 'decision-1', title: "Activate agent 'coding-manager' v1.0.0?", expiresAt,
        reason: 'Publish this Files draft.', command: 'Files draft publication', origin: { kind: 'files_publish' },
      },
    });

    expect(restored).toMatchObject({
      kind: 'tool_approval', approvalId: 'decision-1', decision: 'pending',
      title: "Activate agent 'coding-manager' v1.0.0?", expiresAt, origin: { kind: 'files_publish' },
    });
  });

  it('renders the file publish result as a transcript message beneath the approval card', () => {
    // risk: user consent — approval outcomes must remain visible after the card is settled or the chat is reloaded.
    const dispatcher = createMessageDispatcher();
    const messages: any[] = [];
    const ctx: any = { messages, graphRunning: { value: true }, registry: { setLoading: vi.fn() } };
    dispatcher.dispatch(ctx, 'sulla-desktop', 'chat-thread', {
      type: 'assistant_message',
      data: { content: 'File version publish approved.', role: 'assistant', kind: 'file_publish_result', thread_id: 'chat-thread', timestamp: 456 },
    } as any);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'file_publish_result', content: 'File version publish approved.' });

    const adapter = Object.create(PersonaAdapter.prototype) as any;
    adapter.firstSeenAt = new Map();
    expect(adapter.mapBackendMessage(messages[0])).toMatchObject({ kind: 'sulla', text: 'File version publish approved.' });
  });
});
