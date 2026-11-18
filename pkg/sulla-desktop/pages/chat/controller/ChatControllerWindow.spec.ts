// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke } }));

import { ChatController } from './ChatController';
import type { UserMessage } from '../models/Message';
import { asMessageId } from '../types/chat';

let nextId = 0;
function user(text: string): UserMessage {
  nextId++;
  return { id: asMessageId(`message-${nextId}`), kind: 'user', createdAt: nextId, text };
}

async function flushIpc(): Promise<void> {
  await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
}

describe('ChatController message window', () => {
  beforeEach(() => { invoke.mockClear(); nextId = 0; });
  afterEach(() => vi.clearAllMocks());

  it('prepends older messages in order without duplicates and pauses trimming while older pages are shown', () => {
    // risk: history pagination must retain the loaded older context while new messages arrive
    const controller = new ChatController();
    const oldest = user('oldest');
    const older = user('older');
    const current = user('current');
    controller.thread.value = { ...controller.thread.value, messages: [current] };

    controller.prependOlder([oldest, older, oldest]);
    expect(controller.messages.value.map(message => message.id)).toEqual([oldest.id, older.id, current.id]);

    const extraOlder = user('extra-oldest');
    controller.prependOlder([extraOlder]);
    for (let index = 0; index < 50; index++) controller.appendMessage(user(`new-${index}`));
    expect(controller.messages.value[0].id).toBe(extraOlder.id);
    expect(controller.messages.value).toHaveLength(54);
    controller.dispose();
  });

  it('trims to the newest messages again when older-page browsing is released', () => {
    // risk: releasing history paging must restore the bounded transcript without dropping its newest turn
    const controller = new ChatController();
    const older = user('older');
    controller.prependOlder([older]);
    for (let index = 0; index < 51; index++) controller.appendMessage(user(`new-${index}`));

    controller.releaseOlderPages();
    expect(controller.messages.value).toHaveLength(50);
    expect(controller.messages.value.some(message => message.id === older.id)).toBe(false);
    expect((controller.messages.value.at(-1) as UserMessage).text).toBe('new-50');
    controller.dispose();
  });

  it('does not durably delete the previous conversation when starting a new chat', () => {
    // risk: New chat must preserve the previous thread in History for reopening
    const controller = new ChatController();
    const previousThreadId = controller.thread.value.id;
    controller.newChat();
    expect(controller.thread.value.id).not.toBe(previousThreadId);
    expect(invoke).not.toHaveBeenCalledWith('chat-messages:delete', previousThreadId);
    controller.dispose();
  });

  it('durably deletes the discarded tail when regenerating from a user message', async () => {
    // risk: regenerated turns must not reappear from durable storage after their in-memory tail is removed
    const controller = new ChatController();
    const first = user('first');
    const discardedOne = user('discarded one');
    const discardedTwo = user('discarded two');
    controller.thread.value = { ...controller.thread.value, messages: [first, discardedOne, discardedTwo] };

    controller.regenerate(first.id);
    await flushIpc();
    expect(invoke).toHaveBeenCalledWith('chat-messages:delete-messages', {
      threadId: controller.thread.value.id,
      messageIds: [discardedOne.id, discardedTwo.id],
    });
    controller.dispose();
  });

  it('durably deletes a removed message by id', async () => {
    // risk: explicit message deletion must also remove the durable record
    const controller = new ChatController();
    const removed = user('remove me');
    controller.thread.value = { ...controller.thread.value, messages: [removed] };

    controller.removeMessage(removed.id);
    await flushIpc();
    expect(invoke).toHaveBeenCalledWith('chat-messages:delete-messages', {
      threadId: controller.thread.value.id,
      messageIds: [removed.id],
    });
    expect(controller.messages.value).toEqual([]);
    controller.dispose();
  });
});
