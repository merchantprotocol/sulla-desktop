// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

async function serviceThatFails(error: Error) {
  const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
  const service = Object.create(BackendGraphWebSocketService.prototype);
  const sent: { channelId: string; msg: any }[] = [];
  service.wsService = { send: (channelId: string, msg: any) => { sent.push({ channelId, msg }); return true } };
  service.handleChannelMessage = vi.fn(() => Promise.reject(error));
  return { service, sent };
}

describe('a chat turn that fails before it starts', () => {
  // risk: the user's message vanished and the chat stayed "working" forever
  // because an early database error was never reported to the window.
  it('tells the window what went wrong and ends the working state for that thread', async() => {
    const { service, sent } = await serviceThatFails(new Error('relation "sulla_settings" does not exist'));

    await service.handleChannelMessageSafely('sulla-desktop', 'sulla-desktop', {
      type: 'user_message', data: { content: 'status?', threadId: 'thread-1' },
    });

    const error = sent.find(s => s.msg.type === 'assistant_message');
    expect(error?.msg.data.thread_id).toBe('thread-1');
    expect(error?.msg.data.content).toContain('sulla_settings');
    const done = sent.find(s => s.msg.data?.content === 'graph_execution_complete');
    expect(done?.msg.data.thread_id).toBe('thread-1');
    expect(sent.every(s => s.channelId === 'sulla-desktop')).toBe(true);
  });

  it('stays quiet for non-chat frames so background traffic never posts errors into a chat', async() => {
    const { service, sent } = await serviceThatFails(new Error('boom'));

    await service.handleChannelMessageSafely('sulla-desktop', 'sulla-desktop', { type: 'agent_inbox_message', data: {} });

    expect(sent).toEqual([]);
  });
});
