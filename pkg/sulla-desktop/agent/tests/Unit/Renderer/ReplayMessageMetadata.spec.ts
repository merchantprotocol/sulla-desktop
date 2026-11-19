// SPDX-License-Identifier: GPL-2.0-or-later
// Restart replay keeps each saved message's original time; the real PersonaAdapter.syncMessages
// and ChatController run, with only the transport (ChatInterface/IPC) faked as in ReadinessAdapter.spec.
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { asMessageId } from '@pkg/pages/chat/types/chat';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: {} }));
vi.mock('@pkg/pages/agent/ChatInterface', () => ({ ChatInterface: class {} }));

const SAVED_USER_ID = 'user_1794913291482_xcta0d';
const SAVED_AT = 1794913291482;

/** The real adapter with its own sync state; ci is the backend message list the transport would push. */
async function adapterFor(controller: ChatController, backend: any[]) {
  const { PersonaAdapter } = await import('@pkg/pages/chat/services/PersonaAdapter');
  const { VoiceTranscriptTagger } = await import('@pkg/pages/chat/services/VoiceTranscriptTagger');
  const adapter: any = Object.create(PersonaAdapter.prototype);
  Object.assign(adapter, {
    controller, ci: { messages: ref(backend), graphRunning: ref(false) },
    seen: new Set(), optimisticUserMessages: new Map(), pendingA2aStatuses: new Map(), firstSeenAt: new Map(), firstCompletedAt: new Map(), seenRunning: new Set(),
    lastMappedHash: new Map(), lastRawSignature: new Map(), decisionStatus: new Map(), decisionExpiry: new Map(),
    voiceTranscriptTagger: new VoiceTranscriptTagger(),
  });
  return adapter;
}

describe('restart replay keeps saved message metadata', () => {
  it('keeps a restored user message time across two replays while its content updates', async() => {
    const controller = new ChatController();
    controller.appendMessage({ id: asMessageId(SAVED_USER_ID), kind: 'user', createdAt: SAVED_AT, text: 'Return the harmless menu QA' });
    const backend = [{ id: SAVED_USER_ID, role: 'user', content: 'Return the harmless menu QA' }];
    const adapter = await adapterFor(controller, backend);
    vi.useFakeTimers({ now: SAVED_AT + 3_600_000 });
    try {
      adapter.syncMessages();
      backend[0] = { ...backend[0], content: 'Return the harmless menu QA (edited)' };
      adapter.ci.messages.value = [...backend];
      adapter.syncMessages();
    } finally { vi.useRealTimers() }
    const message = controller.messages.value.find(item => item.id === SAVED_USER_ID) as any;
    expect(message.createdAt).toBe(SAVED_AT);
    expect(message.text).toBe('Return the harmless menu QA (edited)');
    controller.dispose();
  });

  it('keeps an answered question answered and on its saved time when replayed', async() => {
    const controller = new ChatController();
    const id = asMessageId('1794913300000_ws_question');
    controller.appendMessage({ id, kind: 'tool_question', createdAt: 1794913300000, questionId: 'q-1', questions: [{ question: 'Pick?', options: [] }] as any, status: 'answered', answers: [{ question: 'Pick?', selected: ['A'] }] as any });
    const adapter = await adapterFor(controller, [{ id: '1794913300000_ws_question', role: 'assistant', kind: 'tool_question', toolQuestion: { questionId: 'q-1', questions: [{ question: 'Pick?', options: [] }] } }]);
    adapter.syncMessages();
    const message = controller.messages.value.find(item => item.id === id) as any;
    expect(message).toMatchObject({ status: 'answered', createdAt: 1794913300000 });
    controller.dispose();
  });

  it('lets a later database hydrate with the correct time win over an earlier replay time', async() => {
    const controller = new ChatController();
    const id = 'user_without_time';
    const backend = [{ id, role: 'user', content: 'first' }];
    const adapter = await adapterFor(controller, backend);
    vi.useFakeTimers({ now: 1794999999000 });
    try { adapter.syncMessages() } finally { vi.useRealTimers() }
    // The durable copy arrives with the original time.
    const state = controller.serialize();
    state.thread.messages = state.thread.messages.map(message => message.id === id ? { ...message, createdAt: SAVED_AT } : message);
    controller.hydrate(state);
    backend[0] = { ...backend[0], content: 'first, streamed more' };
    adapter.ci.messages.value = [...backend];
    adapter.syncMessages();
    const message = controller.messages.value.find(item => item.id === id) as any;
    expect(message.createdAt).toBe(SAVED_AT);
    expect(message.text).toBe('first, streamed more');
    controller.dispose();
  });

  it('dates a replayed canonical user id from its minted time when no saved copy exists', async() => {
    const controller = new ChatController();
    const adapter = await adapterFor(controller, [{ id: SAVED_USER_ID, role: 'user', content: 'from history' }]);
    adapter.syncMessages();
    expect((controller.messages.value[0] as any).createdAt).toBe(SAVED_AT);
    controller.dispose();
  });

  it('gives a genuinely new message a valid current time', async() => {
    const controller = new ChatController();
    const adapter = await adapterFor(controller, [{ id: 'reply-new', role: 'assistant', content: 'hello' }]);
    const before = Date.now();
    adapter.syncMessages();
    const createdAt = (controller.messages.value[0] as any).createdAt;
    expect(Number.isFinite(createdAt)).toBe(true);
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(Date.now());
    controller.dispose();
  });
});
