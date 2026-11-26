// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';

import ForYouPanel from '@pkg/pages/chat/components/sidedock/ForYouPanel.vue';
import { ChatDecisions } from '@pkg/pages/chat/composables/useChatDecisions';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import type { DecisionRecord } from '@pkg/shared/decisions';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: ipc }));

it('can navigate to a routed approval without settling it, then approve once from the dock', async() => {
  const now = Date.now();
  const owner = ref('thread');
  const record: DecisionRecord = {
    id: 'approval', conversationId: owner.value, channel: 'desktop', title: 'Confirm operation',
    kind: 'approval', status: 'pending', createdAt: now, expiresAt: now + 60_000,
    route: { authority: 'human', chain: [{ threadId: owner.value, channel: 'desktop', agentId: 'human', kind: 'human' }],
      holderIndex: 0, holderSince: now, history: [] },
  };
  ipc.invoke.mockImplementation(async(channel: string) => {
    if (channel === 'decisions:conversation') return [structuredClone(record)];
    if (channel === 'decisions:resolve') { record.status = 'approved'; return { settled: true }; }
    throw new Error('Unexpected IPC: ' + channel);
  });
  const jump = vi.fn();
  const wrapper = mount(defineComponent({ setup() { ChatDecisions.provide(owner); return () => h(ForYouPanel); } }), {
    global: { provide: {
      [ChatControllerKey as symbol]: { thread: ref({ id: 'ui-thread' }), messages: ref([{ id: 'original', kind: 'tool_approval', approvalId: record.id }]) },
      'chat:activity-context': { backendThreadId: owner },
    } },
  });
  window.addEventListener('chat:jump-to-message', jump);
  try {
    await flushPromises();
    const request = wrapper.get('[data-decision-id="approval"]');
    await request.get('.fy-meta button').trigger('click');
    expect(jump.mock.calls[0][0].detail).toEqual({ messageId: 'original' });
    const resolutions = () => ipc.invoke.mock.calls.filter(([channel]) => channel === 'decisions:resolve');
    expect(resolutions()).toEqual([]);
    const approve = request.findAll('button').find(button => button.text() === 'Approve');
    expect(approve).toBeDefined();
    await approve!.trigger('click');
    await flushPromises();
    expect(resolutions()).toEqual([['decisions:resolve', { id: record.id, conversationId: owner.value, action: 'approved' }]]);
  } finally {
    window.removeEventListener('chat:jump-to-message', jump);
    wrapper.unmount();
  }
});
