// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const ipcRenderer = vi.hoisted(() => ({ on: vi.fn(), once: vi.fn(), removeListener: vi.fn(), removeAllListeners: vi.fn(), send: vi.fn(), sendSync: vi.fn(), invoke: vi.fn(async() => undefined) }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, ipcRenderer, safeStorage: {} }));

import { ChatInterface } from '@pkg/pages/agent/ChatInterface';
import { createMessageQueue } from '@pkg/pages/agent/ChatMessageQueue';
import type { HumanSendReceipt } from '@pkg/shared/HumanSend';

const threadId = 'legacy-human-send-thread';

function createLegacyHarness() {
  const graphRunning = ref(true);
  const persona = {
    graphRunning,
    getThreadId: () => threadId,
    messages: [] as any[],
    removeOptimisticHumanMessage: vi.fn(),
    cancelHumanSends: vi.fn(async() => true),
    emitStopSignal: vi.fn(async() => true),
  };
  const chat = Object.create(ChatInterface.prototype) as any;
  chat.persona = persona;
  chat.channelId = 'sulla-desktop';
  chat.tabId = undefined;
  chat.messageQueue = createMessageQueue();
  chat.query = ref('legacy message');
  chat.queueDrainSuspended = false;
  chat.recordHumanSendEnqueued = vi.fn();
  chat.injectMessage = vi.fn(async() => 'injected');
  chat.sendMessageInternal = vi.fn(async() => undefined);
  chat.recordSendHop = vi.fn();
  return { chat, persona, graphRunning };
}

function receipt(sendId: string, status: HumanSendReceipt['status']): HumanSendReceipt {
  return { sendId, threadId, route: 'steer', enqueuedAtMs: 100, status };
}

afterEach(() => vi.unstubAllGlobals());

describe('legacy ChatInterface human send receipts', () => {
  it('steers immediately and keeps the legacy queue row until backend acceptance', async() => {
    // risk: BrowserTabChat/Secretary sends must not wait for idle or disappear before backend acceptance
    const { chat } = createLegacyHarness();
    await chat.send();

    expect(chat.injectMessage).toHaveBeenCalledTimes(1);
    expect(chat.sendMessageInternal).not.toHaveBeenCalled();
    expect(chat.messageQueue.pendingMessages.value).toHaveLength(1);
    const queued = chat.messageQueue.pendingMessages.value[0];
    expect(queued.metadata).toMatchObject({ route: 'steer', deliveryStatus: 'delivering' });
    expect(chat.messageQueue.visiblePendingMessages.value).toHaveLength(0);
    expect(queued.metadata.sendId).toBeTruthy();

    chat.handleHumanSendReceipt(receipt(queued.metadata.sendId, 'accepted'));
    expect(chat.messageQueue.pendingMessages.value).toHaveLength(0);
  });

  it('retains a cancelled in-flight send after Stop and requires explicit retry with a fresh id', async() => {
    // risk: Stop cannot auto-send an unaccepted legacy message after the graph becomes idle
    const { chat, persona } = createLegacyHarness();
    await chat.send();
    const initial = chat.messageQueue.pendingMessages.value[0];
    const initialSendId = initial.metadata.sendId;

    chat.stop();
    await Promise.resolve();
    expect(persona.cancelHumanSends).toHaveBeenCalledWith([initialSendId]);
    expect(chat.messageQueue.pendingMessages.value).toMatchObject([{ metadata: { deliveryStatus: 'pending', cancelledByStop: true } }]);
    chat.handleHumanSendReceipt(receipt(initialSendId, 'cancelled'));
    expect(chat.messageQueue.pendingMessages.value).toMatchObject([{ content: 'legacy message', metadata: { deliveryStatus: 'pending', cancelledByStop: true } }]);

    await chat.processNextQueuedMessage();
    expect(chat.sendMessageInternal).not.toHaveBeenCalled();

    await chat.injectQueuedMessage(initial.id);
    expect(chat.sendMessageInternal).toHaveBeenCalledTimes(1);
    const retry = chat.messageQueue.pendingMessages.value[0];
    expect(retry.metadata.sendId).not.toBe(initialSendId);
    expect(retry.metadata).toMatchObject({ route: 'idle', deliveryStatus: 'delivering', cancelledByStop: false });
    chat.handleHumanSendReceipt(receipt(retry.metadata.sendId, 'accepted'));
    expect(chat.messageQueue.pendingMessages.value).toHaveLength(0);
  });

  it('routes a legacy agent-selection send as a metadata-preserving new turn', async() => {
    // risk: selected-agent routing must interrupt/replace the run instead of losing metadata in steer
    const { chat } = createLegacyHarness();
    await chat.send({ agentId: 'analyst', useCaseIntent: { type: 'agent', slug: 'analyst' } });

    expect(chat.injectMessage).not.toHaveBeenCalled();
    expect(chat.sendMessageInternal).toHaveBeenCalledTimes(1);
    expect(chat.messageQueue.pendingMessages.value[0].metadata).toMatchObject({ agentId: 'analyst', route: 'new_turn', deliveryStatus: 'delivering' });
  });

  it('keeps a route-changing send visible while the legacy graph is running', async() => {
    // risk: stale screen state must not let an agent/use-case change replace an active backend turn invisibly
    const { chat } = createLegacyHarness();
    await chat.send({ agentId: 'analyst', useCaseIntent: { type: 'agent', slug: 'analyst' } });

    expect(chat.injectMessage).not.toHaveBeenCalled();
    expect(chat.sendMessageInternal).not.toHaveBeenCalled();
    expect(chat.messageQueue.visiblePendingMessages.value).toMatchObject([
      { content: 'legacy message', metadata: { agentId: 'analyst', route: 'new_turn', deliveryStatus: 'pending' } },
    ]);
  });

  it('queues an image visibly when a running CLI steer would not carry the binary attachment', async() => {
    // risk: running provider text-only steering must not drop an image payload
    const { chat } = createLegacyHarness();
    await chat.send({}, [{ mediaType: 'image/png', base64: 'cG5n' }]);

    expect(chat.injectMessage).not.toHaveBeenCalled();
    expect(chat.messageQueue.visiblePendingMessages.value).toMatchObject([
      { content: 'legacy message', attachments: [{ mediaType: 'image/png', base64: 'cG5n' }], metadata: { route: 'new_turn', deliveryStatus: 'pending' } },
    ]);
  });

  it('makes a stale-state route rejection visible instead of dropping the fresh send', async() => {
    // risk: a backend-active turn must not be replaced if this renderer reports idle
    const { chat, graphRunning } = createLegacyHarness();
    graphRunning.value = false;
    await chat.send({ agentId: 'analyst' });
    const queued = chat.messageQueue.pendingMessages.value[0];
    expect(queued.metadata).toMatchObject({ deliveryStatus: 'delivering', route: 'idle' });

    chat.handleHumanSendReceipt({
      sendId: String(queued.metadata?.sendId), threadId, route: 'new_turn', path: 'queued',
      enqueuedAtMs: Number(queued.metadata?.enqueuedAtMs), status: 'rejected',
    });

    expect(chat.messageQueue.visiblePendingMessages.value).toMatchObject([
      { content: 'legacy message', metadata: { deliveryStatus: 'pending', cancelledByStop: false, route: 'new_turn', path: 'queued' } },
    ]);
  });

  it('serializes rapid steering sends in order without exposing internal in-flight rows', async() => {
    // risk: quick consecutive sends must neither overtake nor disappear while the graph is running
    const { chat } = createLegacyHarness();
    chat.query.value = 'first';
    const first = chat.send();
    chat.query.value = 'second';
    const second = chat.send();
    await Promise.all([first, second]);

    expect(chat.injectMessage.mock.calls.map(([content]) => content)).toEqual(['first', 'second']);
    expect(chat.messageQueue.visiblePendingMessages.value).toHaveLength(0);
    expect(chat.messageQueue.pendingMessages.value).toHaveLength(2);
  });

  it('coalesces queued voice fragments into one fresh turn after the active run ends', async() => {
    // risk: voice transcription fragments must remain one spoken user turn, not launch parallel replies
    const { chat, graphRunning } = createLegacyHarness();
    chat.messageQueue.enqueue('hello', [], { inputSource: 'voice', sendId: 'voice-one' });
    chat.messageQueue.enqueue('there', [], { inputSource: 'voice', sendId: 'voice-two' });
    graphRunning.value = false;

    await chat.processNextQueuedMessage();

    expect(chat.sendMessageInternal).toHaveBeenCalledTimes(1);
    expect(chat.sendMessageInternal.mock.calls[0][0]).toBe('hello there');
    expect(chat.sendMessageInternal.mock.calls[0][3]).toMatchObject({ route: 'idle', path: 'sent_fresh' });
    expect(chat.sendMessageInternal.mock.calls[0][3].coalescedSendIds).toEqual(['voice-two']);
  });

  it('restores an unacknowledged steer and retries it against the same id after refresh', () => {
    // risk: a renderer refresh during a long run must not strand a send whose backend receipt was lost
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    const first = Object.create(ChatInterface.prototype) as any;
    first.queueStorageKey = 'legacy-pending';
    first.messageQueue = createMessageQueue((messages) => first.persistQueuedMessages(messages));
    first.messageQueue.enqueue('resume this steer', [], {
      sendId: 'hs-persist', route: 'steer', deliveryStatus: 'delivering', enqueuedAtMs: 200,
    });

    const refreshed = Object.create(ChatInterface.prototype) as any;
    refreshed.queueStorageKey = 'legacy-pending';
    refreshed.messageQueue = createMessageQueue((messages) => refreshed.persistQueuedMessages(messages));
    refreshed.restoreQueuedMessages();
    refreshed.persona = { graphRunning: ref(true) };
    refreshed.queueDrainSuspended = false;
    refreshed.injectQueuedMessage = vi.fn(async() => undefined);
    refreshed.resumePendingSteer();

    expect(refreshed.messageQueue.visiblePendingMessages.value).toMatchObject([
      { content: 'resume this steer', metadata: { sendId: 'hs-persist', deliveryStatus: 'pending' } },
    ]);
    expect(refreshed.injectQueuedMessage).toHaveBeenCalledWith(refreshed.messageQueue.pendingMessages.value[0].id);
  });

  it('includes the selected send route in SendHop telemetry', () => {
    // risk: performance evidence must distinguish injection from queueing and a fresh dispatch
    const { chat } = createLegacyHarness();
    delete chat.recordSendHop;
    chat.recordSendHop('injected');

    expect(ipcRenderer.send).toHaveBeenCalledWith('send-hop:log', expect.objectContaining({ threadId, route: 'injected' }));
  });
});
