// SPDX-License-Identifier: GPL-2.0-or-later

import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import type { Message } from '@pkg/pages/chat/models/Message';
import { LocalStoragePersister } from '@pkg/pages/chat/services/LocalStoragePersister';
import { asMessageId, asThreadId } from '@pkg/pages/chat/types/chat';

export type FixtureName = 'long' | 'agent';

export class ConversationFixture {
  static readonly tabId = 'synthetic-chat-preview';

  constructor(private readonly persister: LocalStoragePersister) {}

  seed(fixture: FixtureName): void {
    const state = new ChatController().serialize();
    const id = asThreadId(`synthetic-chat-preview-${fixture}`);
    const start = Date.UTC(2026, 0, 15, 12);
    const messages: Message[] = [];
    const base = (turnId: string) => ({
      id: asMessageId(`preview-message-${messages.length + 1}`),
      createdAt: start + messages.length * 1000,
      turnId,
    });

    const add = (message: Omit<Message, 'id' | 'createdAt'>): void => {
      messages.push({ ...base(message.turnId ?? `preview-turn-${messages.length}`), ...message } as Message);
    };

    const turnId = 'preview-turn-arrival';
    add({ kind: 'user', turnId, text: 'Inspect the synthetic Lantern Bay field notes and verify the route.' });
    add({ kind: 'thinking', turnId, thoughts: ['Reviewing the fixture conversation.', 'Checking the sample route.'], startedAt: start + 100, completed: true, completedAt: start + 900, summary: 'Fixture context reviewed.' });
    add({ kind: 'tool', turnId, tool: 'shell', desc: 'Read the synthetic route notes', status: 'ok', meta: 'exit 0 · 120ms', input: 'cat /synthetic/lantern-bay.md\nAuthorization: Bearer FAKE_TEST_TOKEN_123', output: 'dock=outer\nroute=west-gate' });
    add({ kind: 'tool', turnId, tool: 'shell', desc: 'Retry route verification', status: 'error', meta: 'exit 1 · 80ms', input: 'verify-route --sample', error: 'sample chart unavailable' });
    add({ kind: 'tool', turnId, tool: 'shell', desc: 'Retry route verification', status: 'ok', meta: 'exit 0 · 90ms', input: 'verify-route --sample --retry', output: 'route verified' });
    add({ kind: 'tool', turnId, tool: 'shell', desc: 'Watch the synthetic dock', status: 'running', input: 'tail -f /synthetic/dock-events.log' });
    add({ kind: 'tool_approval', turnId, reason: 'Run the read-only synthetic route check', command: 'verify-route --sample', decision: 'approved', approvalId: 'preview-approval-1', origin: { kind: 'tool' } });
    add({ kind: 'memory', turnId, memId: 'preview-memory', action: 'saved', summary: 'Saved synthetic Lantern Bay route context.' });
    add({ kind: 'heartbeat', turnId, text: 'Synthetic heartbeat: fixture remains healthy.', intervalMinutes: 5 });
    add({ kind: 'citation', turnId, sources: [{ num: 1, title: 'Lantern Bay field guide', origin: 'Synthetic documentation', url: 'https://example.invalid/lantern-bay' }] });
    add({ kind: 'inline_file_reference', turnId, fileId: 'synthetic-file-1', collectionId: 'synthetic-collection', toolCallId: 'preview-tool-1', threadId: 'synthetic-chat-preview-long' });
    add({ kind: 'streaming', turnId, text: 'The route is consistent with the ', startedAt: start + 1000, replyStreamId: 'preview-stream-1' });
    add({ kind: 'streaming', turnId, text: 'synthetic field notes.', startedAt: start + 1100, replyStreamId: 'preview-stream-1' });
    add({ kind: 'sulla', turnId, text: '## Lantern Bay\nThe synthetic route check passed. No real account data is present.', replyAttribution: { model: 'synthetic-preview-model' }, tokens: 184, model: 'synthetic-preview-model' });
    add({ kind: 'user', turnId: 'preview-turn-follow-up', text: 'Show the final checklist too.' });
    add({ kind: 'sulla', turnId: 'preview-turn-follow-up', text: 'Checklist: blue marker, west gate lantern, and outer dock route.', replyAttribution: { model: 'synthetic-preview-model' }, tokens: 72 });

    this.persister.save({
      ...state,
      thread: {
        ...state.thread,
        id,
        title: fixture === 'agent'
          ? 'Lantern Bay Expedition: the exceptionally long synthetic conversation title used to check truncation alongside the agent origin chip and reporting picker'
          : 'Lantern Bay field notes',
        createdAt: start,
        updatedAt: messages.at(-1)?.createdAt ?? start,
        messages,
      },
    });
    this.persister.setTabThread(ConversationFixture.tabId, id);
  }
}
