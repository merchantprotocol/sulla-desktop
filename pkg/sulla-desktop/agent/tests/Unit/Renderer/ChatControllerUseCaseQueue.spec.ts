// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { newMessageId } from '@pkg/pages/chat/types/chat';
import type { UseCaseIntentMetadata } from '@pkg/shared/useCaseSuggestions';

describe('ChatController use-case queue routing', () => {
  it('restores a live run into renderer state when a chat tab is adopted', () => {
    // risk: an adopted live chat must stay marked running so the user cannot accidentally submit a duplicate turn
    const controller = new ChatController();
    controller.restoreActiveRun();
    expect(controller.isRunning.value).toBe(true);
    controller.dispose();
  });

  it('keeps a queued Ask-agent intent intact until the active run is idle', () => {
    // risk: agent routing metadata must not be lost when a queued turn is sent during another run
    const controller = new ChatController();
    const send = vi.fn();
    const inject = vi.fn();
    controller.setSendHandler(send);
    controller.setInjectHandler(inject);
    controller.transitionRun({ type: 'send', messageId: newMessageId() });
    const intent: UseCaseIntentMetadata = { type: 'agent', slug: 'analyst', title: 'Analyst' };
    controller.queueMessage('Ask the analyst', [], { useCaseIntent: intent, agentId: 'analyst' });

    controller.injectQueuedMessage(controller.queue.value[0].id);
    expect(inject).not.toHaveBeenCalled();
    expect(controller.queue.value).toHaveLength(1);
    expect(controller.queue.value[0]).toMatchObject({ useCaseIntent: intent, agentId: 'analyst' });
    expect(controller.visibleQueue.value).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();

    controller.transitionRun({ type: 'idle' });
    controller.drainQueueIfIdle();
    expect(send).toHaveBeenCalledWith('Ask the analyst', [], expect.objectContaining({
      useCaseIntent: intent, agentId: 'analyst', route: 'idle', path: 'sent_fresh',
    }));
    const queued = controller.queue.value[0];
    expect(queued.deliveryStatus).toBe('delivering');
    controller.acknowledgeHumanSend({
      sendId: queued.sendId, threadId: controller.thread.value.id,
      route: 'idle', path: 'sent_fresh', enqueuedAtMs: queued.enqueuedAtMs, status: 'accepted',
    });
    expect(controller.queue.value).toHaveLength(0);
    controller.dispose();
  });

  it('injects plain text during a run and hides the transient queue row until backend acceptance', async() => {
    // risk: a running human-started turn must see the message at the next model boundary, not after idle
    const controller = new ChatController();
    const inject = vi.fn(async() => undefined);
    controller.setInjectHandler(inject);
    controller.transitionRun({ type: 'send', messageId: newMessageId() });

    controller.send('steer this run');
    for (let step = 0; step < 4; step++) await Promise.resolve();

    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0][0]).toBe('steer this run');
    expect(inject.mock.calls[0][2]).toMatchObject({ route: 'steer', path: 'injected' });
    expect(controller.visibleQueue.value).toHaveLength(0);
    const queued = controller.queue.value[0];
    expect(queued.deliveryStatus).toBe('delivering');

    controller.acknowledgeHumanSend({
      sendId: queued.sendId, threadId: controller.thread.value.id,
      route: 'steer', path: 'injected', enqueuedAtMs: queued.enqueuedAtMs, status: 'accepted',
    });
    expect(controller.queue.value).toHaveLength(0);
    controller.dispose();
  });

  it('shows a new-turn queue row when the adapter detects a backend run after the screen reported idle', () => {
    // risk: Ask-agent/use-case sends must remain visible if renderer/backend run state temporarily diverges
    const controller = new ChatController();
    controller.setSendHandler((_text, _attachments, options) => controller.markHumanSendQueued(options!.sendId!));

    controller.send('ask analyst', [], { agentId: 'analyst', useCaseIntent: { type: 'agent', slug: 'analyst' } });

    expect(controller.visibleQueue.value).toMatchObject([
      { text: 'ask analyst', route: 'new_turn', deliveryStatus: 'pending', agentId: 'analyst' },
    ]);
    controller.dispose();
  });

  it('keeps images in the visible fresh-turn queue instead of a text-only live steer', () => {
    // risk: a CLI text-only steer must not acknowledge and lose an image attachment
    const controller = new ChatController();
    const inject = vi.fn();
    controller.setInjectHandler(inject);
    controller.transitionRun({ type: 'send', messageId: newMessageId() });
    const image = { id: 'image-1', name: 'diagram.png', kind: 'image', size: '8 B' } as any;

    controller.send('inspect this', [image]);

    expect(inject).not.toHaveBeenCalled();
    expect(controller.visibleQueue.value).toMatchObject([
      { text: 'inspect this', route: 'new_turn', deliveryStatus: 'pending', attachments: [image] },
    ]);
    controller.dispose();
  });

  it('delivers five rapid sends in order and only removes them after receipts', async() => {
    // risk: concurrent keystrokes must neither overtake nor vanish before acceptance
    const controller = new ChatController();
    const received: string[] = [];
    controller.setInjectHandler(vi.fn(async(text: string) => { received.push(text); }));
    controller.transitionRun({ type: 'send', messageId: newMessageId() });

    for (let index = 1; index <= 5; index++) controller.send(`typed ${ index }`);
    for (let step = 0; step < 12; step++) await Promise.resolve();

    expect(received).toEqual(['typed 1', 'typed 2', 'typed 3', 'typed 4', 'typed 5']);
    expect(controller.queue.value).toHaveLength(5);
    expect(controller.visibleQueue.value).toHaveLength(0);
    for (const queued of [...controller.queue.value]) controller.acknowledgeHumanSend({
      sendId: queued.sendId, threadId: controller.thread.value.id,
      route: 'steer', path: 'injected', enqueuedAtMs: queued.enqueuedAtMs, status: 'accepted',
    });
    expect(controller.queue.value).toHaveLength(0);
    controller.dispose();
  });

  it('coalesces queued voice fragments before dispatching one voice turn', async() => {
    // risk: voice backstop fragments must not produce separate or parallel agent turns
    const controller = new ChatController();
    const send = vi.fn();
    controller.setSendHandler(send);
    controller.transitionRun({ type: 'send', messageId: newMessageId() });
    controller.send('good', [], { inputSource: 'voice', voiceTurnId: 'voice-turn' });
    controller.send('morning', [], { inputSource: 'voice', voiceTurnId: 'voice-turn' });
    const fragmentSendId = controller.queue.value[1].sendId;

    controller.transitionRun({ type: 'idle' });
    controller.drainQueueIfIdle();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('good morning');
    expect(send.mock.calls[0][2]).toMatchObject({ inputSource: 'voice', voiceTurnId: 'voice-turn' });
    expect(send.mock.calls[0][2].coalescedSendIds).toEqual([fragmentSendId]);
    expect(controller.queue.value).toHaveLength(1);
    controller.dispose();
  });

  it('restores an unacknowledged in-flight send as a visible retry with the same id', () => {
    // risk: refresh/close during delivery must not strand a hidden, undelivered user message
    const controller = new ChatController();
    controller.queueMessage('resume after refresh');
    const sendId = controller.queue.value[0].sendId;
    controller.queue.value[0].deliveryStatus = 'delivering';
    const snapshot = controller.serialize();

    const restored = new ChatController({ hydrateFrom: snapshot });
    expect(restored.queue.value[0]).toMatchObject({ sendId, deliveryStatus: 'pending', text: 'resume after refresh' });
    expect(restored.visibleQueue.value).toHaveLength(1);
    controller.dispose();
    restored.dispose();
  });
});
