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

    for (const topic of ['Arrival', 'Inventory', 'Navigation', 'Observations', 'Checklist', 'Summary']) {
      const turnId = `preview-turn-${topic.toLowerCase()}`;
      messages.push({ ...base(turnId), kind: 'user', text: `Show the synthetic field notes for ${topic.toLowerCase()}.` });
      messages.push({
        ...base(turnId),
        kind: 'sulla',
        text: [
          `## ${topic}: Lantern Bay field notes`,
          'This synthetic conversation is used to check the chat transcript. These notes describe a fictional location and contain no account data.',
          '### Items to review',
          '- Blue marker at the outer dock\n- Lantern logged by the west gate\n- Route checked against the sample chart',
          '```ts\nconst route = { dock: "outer", marker: "blue", checked: true };\n```',
        ].join('\n\n'),
      });
      messages.push({
        ...base(turnId),
        kind: 'citation',
        sources: ['Lantern Bay field guide', 'Sample route chart', 'Fictional inventory ledger'].map((title, index) => ({
          num: index + 1,
          title,
          origin: 'Synthetic documentation',
          url: `https://example.invalid/lantern-bay/source-${index + 1}`,
        })),
      });
    }

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
