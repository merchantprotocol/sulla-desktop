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
  scope = { accountId: 'account-a', workspaceId: 'team-a', deviceId: 'viewer-a', historyOnly: false };
  readonly opened: (boolean | undefined)[] = [];
  async connect(bound?: boolean) { this.opened.push(bound); return this.scope }
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

  // risk: new viewers cannot invent a thread or carry discoveries across scopes.
  it('exposes discovery only for the current proof request and discards it on disconnect', async() => {
    const transport = new FixtureTransport();
    const chat = new ChatController();
    const viewer = new RemoteChatSession(chat, transport, () => {}, () => true);
    viewer.mount();
    try {
      await viewer.refresh();
      const requestId = transport.sent[0].requestId;
      const device = { id: 'host-a', name: 'Mac', models: [],
        threads: [{ id: 'remote_canonical_123456', updatedAt: 1000 }] };
      transport.emit({ type: 'relay_inventory_device', requestId: 'old-proof', device });
      transport.emit({ type: 'relay_inventory_complete', requestId: 'old-proof' });
      expect(chat.remoteDiscoveries.value).toEqual([]);
      transport.emit({ type: 'relay_inventory_device', requestId, device });
      transport.emit({ type: 'relay_inventory_complete', requestId });
      expect(chat.remoteDiscoveries.value).toEqual([{ updatedAt: 1000, binding: {
        accountId: 'account-a', workspaceId: 'team-a', threadId: 'remote_canonical_123456', deviceId: 'host-a', name: 'Mac',
      } }]);
      expect(transport.sent.some(frame => frame.type === 'chat')).toBe(false);
      transport.emit({ type: 'viewer_disconnected' });
      expect(chat.remoteDiscoveries.value).toEqual([]);
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


// risk: inventory leakage between accounts, workspaces and viewing devices.
it.each([{ accountId: 'account-b' }, { workspaceId: 'team-b' }, { deviceId: 'viewer-b' }])(
  'keeps the paired set disabled offline and clears it on context change (%j)', async (change) => {
    const transport = new FixtureTransport();
    const chat = new ChatController();
    const viewer = new RemoteChatSession(chat, transport, () => {}, () => true);
    viewer.mount();
    try {
      await viewer.refresh();
      const requestId = transport.sent.at(-1)?.requestId;
      for (const id of ['host-a', 'host-b']) {
        transport.emit({ type: 'relay_inventory_device', requestId, device: { id, name: id, models: [{ providerId: 'p', modelId: 'm' }] } });
      }
      transport.emit({ type: 'relay_inventory_complete', requestId });
      transport.emit({ type: 'viewer_disconnected' });
      expect(viewer.pickerDevices.value).toEqual(['host-a', 'host-b'].map(id =>
        expect.objectContaining({ id, online: false, models: [] })));
      expect(chat.remoteDiscoveries.value).toEqual([]);
      await viewer.refresh();
      transport.emit({ type: 'relay_inventory_complete', requestId: transport.sent.at(-1)?.requestId, offline: ['host-a'] });
      expect(viewer.pickerDevices.value.map(device => device.id)).toEqual(['host-a']);
      transport.emit({ type: 'viewer_disconnected' });
      transport.scope = { ...transport.scope, ...change };
      await viewer.refresh();
      expect(viewer.pickerDevices.value).toEqual([]);
    } finally {
      viewer.dispose();
      chat.dispose();
    }
  });

// risk: rollback may reopen existing history but must not start or stop execution.
it('subscribes a cold bound thread for history only with no starting inventory', async () => {
  const transport = new FixtureTransport();
  transport.scope.historyOnly = true;
  const chat = new ChatController();
  const binding = { accountId: 'account-a', workspaceId: 'team-a', threadId: 'remote_canonical_123456', deviceId: 'host-a', name: 'Mac' };
  chat.thread.value = { ...chat.thread.value, remote: binding };
  const viewer = new RemoteChatSession(chat, transport, () => {}, () => true);
  viewer.mount();
  try {
    const history = vi.spyOn(transport, 'history');
    await viewer.refresh();
    expect(transport.opened).toEqual([true]);
    expect(transport.sent.map(frame => frame.type)).toEqual(['relay_subscribe']);
    transport.emit({ type: 'relay_subscribed', historyOnly: true, conversationId: binding.threadId,
      deviceId: binding.deviceId, subscriptionId: transport.sent[0].subscriptionId });
    await vi.waitFor(() => expect(history).toHaveBeenCalled());
    expect(viewer.canSend()).toBe(false);
    await viewer.sendDraft('do not execute');
    viewer.stop();
    expect(transport.sent.map(frame => frame.type)).toEqual(['relay_subscribe']);
  } finally {
    viewer.dispose();
    chat.dispose();
  }
});
