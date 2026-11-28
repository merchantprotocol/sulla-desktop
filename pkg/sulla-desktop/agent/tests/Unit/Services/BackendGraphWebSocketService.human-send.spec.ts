// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

const channelId = 'sulla-desktop';
const threadId = 'thread-human-send';

async function createIntakeHarness() {
  const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
  const { GraphRegistry } = await import('../../../services/GraphRegistry');
  const state = { messages: [] as any[], metadata: { threadId, currentTool: 'bash' } };
  const sent: { channelId: string; msg: any }[] = [];
  const service = Object.create(BackendGraphWebSocketService.prototype) as any;
  service.wsService = { send: (target: string, msg: any) => { sent.push({ channelId: target, msg }); return true } };
  service.activeAborts = new Map([[`${ channelId }|${ threadId }`, new AbortController()]]);
  service.humanSendReceipts = new Map();
  service.cancelledHumanSends = new Set();
  service.humanSendInFlight = new Set();
  service.humanSendWaitRecorder = { accepted: vi.fn() };
  service.applySupportSessionCapability = vi.fn(async() => undefined);
  service.dispatchToAgent = vi.fn(async() => 'accepted');
  const graphLookup = vi.spyOn(GraphRegistry, 'get').mockImplementation((id: string) => id === threadId ? { state } as any : null);
  const handle = (type: string, data: Record<string, unknown>) => service.handleChannelMessage(channelId, channelId, { type, data } as any);
  return { service, state, sent, handle, graphLookup };
}

afterEach(() => vi.restoreAllMocks());

describe('human message acceptance during an active run', () => {
  it('accepts a steer alongside a simultaneous helper completion and dedupes a retried send id', async() => {
    // risk: a live steer must not create a second graph or overwrite a helper completion racing into the same state
    const { service, state, sent, handle } = await createIntakeHarness();
    const helperCompletion = { id: 'helper-result', role: 'assistant', content: 'helper result' };
    const humanSend = { sendId: 'hs-one', route: 'steer', enqueuedAtMs: 100 };
    const message = { content: 'continue with this', threadId, metadata: { supportSessionId: 'support-session' }, humanSend };
    service.applySupportSessionCapability = vi.fn(async() => { state.messages.push(helperCompletion); });

    await handle('inject_message', message);
    await handle('inject_message', message); // same packet retried after its transport acknowledgement raced

    expect(state.messages).toHaveLength(2);
    expect(state.messages.filter(item => item.content === 'continue with this')).toHaveLength(1);
    expect(state.messages.filter(item => item.id === 'helper-result')).toHaveLength(1);
    expect(service.dispatchToAgent).not.toHaveBeenCalled();
    expect(service.humanSendWaitRecorder.accepted).toHaveBeenCalledTimes(1);
    const receipts = sent.filter(item => item.msg.type === 'human_send_receipt');
    expect(receipts.map(item => item.msg.data.status)).toEqual(['accepted', 'accepted']);
    expect(receipts.every(item => item.msg.data.sendId === 'hs-one' && item.msg.data.route === 'steer')).toBe(true);
  });

  it('cancels a not-yet-accepted send id before a queued packet can append it', async() => {
    // risk: Stop racing an unaccepted packet must leave it in the composer queue, not inject or restart a run
    const { service, state, sent, handle } = await createIntakeHarness();

    await handle('cancel_human_send', { threadId, sendIds: ['hs-cancel'] });
    await handle('inject_message', {
      content: 'must stay queued', threadId, metadata: {},
      humanSend: { sendId: 'hs-cancel', route: 'steer', enqueuedAtMs: 100 },
    });

    expect(state.messages).toHaveLength(0);
    expect(service.dispatchToAgent).not.toHaveBeenCalled();
    expect(sent.filter(item => item.msg.type === 'human_send_receipt').map(item => item.msg.data.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('rejects a route-changing send into a visible new-turn queue while the backend run is active', async() => {
    // risk: Ask-agent/use-case routing must not replace the live run when the renderer's run flag is stale
    const { service, sent, handle } = await createIntakeHarness();
    await handle('user_message', {
      content: 'route this', threadId, metadata: { agentId: 'analyst', useCaseIntent: { type: 'agent', slug: 'analyst' } },
      humanSend: { sendId: 'hs-route', route: 'new_turn', enqueuedAtMs: 150 },
    });

    const receipt = sent.find(item => item.msg.type === 'human_send_receipt')?.msg.data;
    expect(receipt).toMatchObject({ sendId: 'hs-route', threadId, route: 'new_turn', path: 'queued', status: 'rejected' });
    expect(service.dispatchToAgent).not.toHaveBeenCalled();
  });

  it('hands an inject to a fresh turn if the active run finishes during capability setup', async() => {
    // risk: a last-second send must be consumed by the old run or redelivered once, never orphaned
    const { service, state, sent, handle } = await createIntakeHarness();
    const runKey = `${ channelId }|${ threadId }`;
    service.applySupportSessionCapability = vi.fn(async() => {
      service.activeAborts.set(runKey, new AbortController());
    });
    service.dispatchToAgent = vi.fn(async(...args: any[]) => {
      const acceptedSend = args[7]?.humanSend;
      if (acceptedSend) service.acceptHumanSend(channelId, threadId, acceptedSend);
      return 'accepted';
    });

    await handle('inject_message', {
      content: 'arrived at finish', threadId,
      metadata: { supportSessionId: 'support-session' },
      humanSend: { sendId: 'hs-finish-race', route: 'steer', enqueuedAtMs: 175 },
    });

    expect(state.messages.filter(item => item.content === 'arrived at finish')).toHaveLength(0);
    expect(service.dispatchToAgent).toHaveBeenCalledTimes(1);
    expect(service.dispatchToAgent.mock.calls[0][7].humanSend).toMatchObject({ sendId: 'hs-finish-race', route: 'new_turn', path: 'sent_fresh' });
    expect(sent.filter(item => item.msg.type === 'human_send_receipt').map(item => item.msg.data.status)).toEqual(['accepted']);
  });

  it('appends five rapid steers once each and preserves send order', async() => {
    // risk: bursts of typed messages must be delivered once and in FIFO order
    const { service, state, handle } = await createIntakeHarness();
    for (let index = 1; index <= 5; index++) {
      await handle('inject_message', {
        content: `message ${ index }`, threadId, metadata: {},
        humanSend: { sendId: `hs-fast-${ index }`, route: 'steer', enqueuedAtMs: 200 + index },
      });
    }

    expect(state.messages.map(item => item.content)).toEqual(['message 1', 'message 2', 'message 3', 'message 4', 'message 5']);
    expect(service.humanSendReceipts.size).toBe(5);
  });

  it('acknowledges every coalesced voice fragment for one combined backend message', async() => {
    // risk: voice backstop coalescing must keep all fragment ids retry-safe without duplicating the utterance
    const { service, state, sent, handle } = await createIntakeHarness();
    await handle('inject_message', {
      content: 'hello there', threadId, metadata: {},
      humanSend: { sendId: 'hs-voice-one', coalescedSendIds: ['hs-voice-two'], route: 'steer', enqueuedAtMs: 250 },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe('hello there');
    expect(service.humanSendReceipts.size).toBe(2);
    expect(sent.filter(item => item.msg.type === 'human_send_receipt').map(item => item.msg.data.sendId)).toEqual(['hs-voice-one', 'hs-voice-two']);
  });
});
