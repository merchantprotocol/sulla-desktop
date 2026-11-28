// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { PersonaAdapter } from '@pkg/pages/chat/services/PersonaAdapter';
import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { asMessageId } from '@pkg/pages/chat/types/chat';
import type { Message } from '@pkg/pages/chat/models/Message';
import { ChatInterface } from '@pkg/pages/agent/ChatInterface';

const { logger } = vi.hoisted(() => ({ logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('electron', () => {
  const ipcRenderer = { invoke: vi.fn().mockResolvedValue([]), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
  return { ipcRenderer, default: { ipcRenderer } };
});
vi.mock('@pkg/utils/logging', () => ({
  default: new Proxy({}, { get: () => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), stream: { write: vi.fn() } }) }),
}));
vi.mock('@pkg/agent/services/SullaLogger', () => ({ SullaLogger: { topic: () => logger } }));

describe('PersonaAdapter tool-step mapping', () => {
  it('persists the backend step contract on the transcript tool row', () => {
    // risk: data accuracy — reloadable history must retain step timestamps and safe labels from the backend card.
    const adapter = Object.create(PersonaAdapter.prototype) as any;
    adapter.firstSeenAt = new Map();
    const meta = { step: { stepId: 'step-1', runId: 'run-1', provider: 'codex', source: 'codex_cli',
      safeLabel: 'git', startedAt: 1_000, endedAt: 2_000, durationMs: 1_000, ok: true } };

    const mapped = adapter.mapBackendMessage({ id: '1_tool_git', kind: 'tool', role: 'assistant', toolCard: {
      toolName: 'exec', label: 'Bash', summary: 'Running command', status: 'success', args: { command: 'git status --short' }, meta,
    } });

    expect(mapped).toMatchObject({ kind: 'tool', status: 'ok', meta });
  });

  it('keeps a restored running tool until a real backend run-end transition', async() => {
    // risk: correctness — renderer mount starts locally idle even while a restored backend tool is still live.
    const controller = new ChatController();
    const state = controller.serialize();
    const startedAt = 1_000;
    const tool = {
      id: asMessageId('tool-restored-running'), kind: 'tool', createdAt: startedAt, tool: 'Bash', recordedToolName: 'exec',
      desc: 'Running command', status: 'running', input: '{"command":"git status"}',
      meta: { step: { stepId: 'step-1', runId: 'run-1', provider: 'codex', source: 'codex_cli', safeLabel: 'git', startedAt } },
    } satisfies Message;
    controller.hydrate({ ...state, thread: { ...state.thread, messages: [tool] } });
    const ci = {
      messages: ref([]), messagesRevision: ref(0), graphRunning: ref(false), threadId: ref('backend-thread'),
      hasMessages: ref(false), showContinueButton: ref(false), dispose: vi.fn(),
      onSpeakDispatch: () => () => {}, totalTokensUsed: ref(0), totalPromptTokens: ref(0), totalCompletionTokens: ref(0),
      totalInputCost: ref(0), totalOutputCost: ref(0), totalCost: ref(0), responseCount: ref(0),
      averageResponseTime: ref(0), tokensPerSecond: ref(0),
    };
    const fakeWindow = { addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() };
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('CustomEvent', class { constructor(readonly type: string, readonly init?: unknown) {} });
    const adapter = new PersonaAdapter(controller, {}, ci as any);

    try {
      expect(controller.messages.value[0]).toMatchObject({ kind: 'tool', status: 'running', meta: tool.meta });

      ci.graphRunning.value = true;
      await nextTick();
      expect(controller.messages.value[0]).toMatchObject({ kind: 'tool', status: 'running' });

      ci.graphRunning.value = false;
      await nextTick();
      expect(controller.messages.value[0]).toMatchObject({ kind: 'tool', status: 'error', error: 'Interrupted after app restart.' });
      expect(fakeWindow.dispatchEvent.mock.calls.map(([event]) => (event as any).type)).toContain('sulla:chat-run-ended');
    } finally {
      adapter.dispose();
      controller.dispose();
      vi.unstubAllGlobals();
    }
  });
});

describe('ChatInterface local restore', () => {
  it('keeps a stored running tool card provisional until backend state is known', () => {
    // risk: correctness — local renderer storage cannot prove that a backend tool call was interrupted.
    const storedMessage = {
      id: '1_tool_exec', role: 'assistant', kind: 'tool', toolCard: {
        toolName: 'exec', label: 'Bash', summary: 'Running command', status: 'running',
        meta: { step: { stepId: 'step-1', runId: 'run-1', provider: 'codex', source: 'codex_cli',
          safeLabel: 'git', startedAt: 1_000 } },
      },
    };
    const chatInterface = Object.create(ChatInterface.prototype) as any;
    chatInterface.messagesStorageKey = 'chat_messages_fixture';
    chatInterface.persona = { messages: [] };
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => JSON.stringify([storedMessage])) });

    try {
      chatInterface.restoreMessages();

      expect(chatInterface.persona.messages[0].toolCard).toMatchObject({ status: 'running', meta: storedMessage.toolCard.meta });
      expect(chatInterface.persona.messages[0].toolCard.error).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
