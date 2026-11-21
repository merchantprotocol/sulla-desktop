// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { RemoteChatSession, type RemoteChatTransport } from '@pkg/pages/chat/services/RemoteChatSession';

type Frame = Record<string, unknown>;
class FixtureTransport implements RemoteChatTransport {
  readonly sent: Frame[] = [];
  private listener?: (frame: Frame) => void;
  async connect() { return { accountId: 'account-a', workspaceId: 'team-a' } }
  async send(frame: Frame) { this.sent.push(frame); return true }
  listen(listener: (frame: Frame) => void) {
    this.listener = listener;
    return () => { this.listener = undefined };
  }
  async history() { return { status: 404 } }
  emit(frame: Frame) { this.listener?.(frame) }
}

afterEach(() => vi.useRealTimers());

describe('Remote Desktop chat', () => {
  // risk: wrong-device execution and duplicate side effects after an ambiguous ACK.
  it('keeps the draft, waits for the exact host receipt, and never sends or stops via the local graph', async() => {
    vi.useFakeTimers();
    const transport = new FixtureTransport();
    const local: string[] = [];
    const cleared: string[] = [];
    const chat = new ChatController({ sendHandler: text => local.push(text) });
    const viewer = new RemoteChatSession(chat, transport, text => cleared.push(text), () => true);
    viewer.mount();
    try {
      await viewer.refresh();
      const model = { modelId: 'genuine', providerId: 'the-provider' };
      const mac = { id: 'mac', name: 'Mac', models: [model] };
      const requestId = transport.sent[0].requestId;
      transport.emit({ type: 'relay_inventory_device', requestId, device: mac });
      transport.emit({ type: 'relay_inventory_complete', requestId });
      viewer.select(mac);

      chat.send('not permitted through a local adapter');
      viewer.model.value = { ...model, modelId: 'not-on-the-host' };
      await viewer.sendDraft('hello');
      expect(transport.sent.filter(frame => frame.type === 'chat')).toHaveLength(0);
      expect(local).toEqual([]);

      viewer.model.value = model;
      await viewer.sendDraft('hello');
      const sent = transport.sent.find(frame => frame.type === 'chat')!;
      expect(sent).toMatchObject({ targetDeviceId: 'mac', ...model, text: 'hello' });
      expect(viewer.running.value).toBe(false);
      expect(cleared).toEqual([]);
      await vi.advanceTimersByTimeAsync(8000);
      const lookup = transport.sent.find(frame => frame.type === 'relay_receipt');
      expect(lookup).toMatchObject({ userMessageId: sent.userMessageId, targetDeviceId: 'mac' });
      await viewer.sendDraft('hello');
      expect(transport.sent.filter(frame => frame.type === 'chat')).toHaveLength(1);

      const ack = { type: 'ack', conversationId: sent.conversationId, userMessageId: sent.userMessageId, deviceId: 'mac' };
      transport.emit({ ...ack, deviceId: 'wrong-host' });
      expect(cleared).toEqual([]);
      transport.emit(ack);
      expect(cleared).toEqual(['hello']);
      expect(viewer.running.value).toBe(true);
      chat.stop();
      expect(transport.sent.at(-1)).toMatchObject({ type: 'cancel', clientRunId: sent.userMessageId, targetDeviceId: 'mac' });
      expect(local).toEqual([]);
    } finally {
      viewer.dispose();
      chat.dispose();
    }
  });

  // risk: local chat availability; Cloud is not a dependency when using This device.
  it('preserves the original local send path without an enrolled remote viewer', () => {
    const local: string[] = [];
    const chat = new ChatController({ sendHandler: text => local.push(text) });
    const viewer = new RemoteChatSession(chat, new FixtureTransport(), () => {}, () => true);
    viewer.mount();
    try {
      chat.send('local chat');
      expect(local).toEqual(['local chat']);
    } finally {
      viewer.dispose();
      chat.dispose();
    }
  });
});
