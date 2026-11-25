// @vitest-environment jsdom
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';

const harness = vi.hoisted(() => ({
  store: {
    decisions: { value: [] as any[] },
    inlineRecord: vi.fn(() => undefined as any),
    checkingInline: vi.fn(() => false),
    inlineReadFailed: { value: false },
    refreshInline: vi.fn(),
    now: { value: Date.now() },
    actionError: vi.fn(),
    busy: vi.fn(() => false),
    draft: vi.fn(() => ({ picks: [], other: [], customSelected: [] })),
  },
  controller: { approveTool: vi.fn(), denyTool: vi.fn() },
}));

vi.mock('../../../../pages/chat/composables/useChatDecisions', () => ({ ChatDecisions: { useChatDecisions: () => harness.store } }));
vi.mock('../../../../pages/chat/controller/useChatController', () => ({ useChatController: () => harness.controller }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: new Proxy({}, { get: () => vi.fn() }) }));

import MessageRouter from '../../../../pages/chat/components/transcript/MessageRouter.vue';

describe('MessageRouter Files approval trust', () => {
  afterEach(() => { vi.clearAllMocks(); harness.store.decisions.value = []; });

  it('does not render transcript-supplied Files approval text when no approval record is loaded', () => {
    // risk: consent integrity — an unverified transcript card must not impersonate a Files approval or expose a legacy approve action.
    const wrapper = mount(MessageRouter, { props: {
      msg: {
        id: 'spoofed-message', kind: 'tool_approval', createdAt: Date.now(), approvalId: 'missing-decision',
        title: 'UNTRUSTED TITLE', reason: 'UNTRUSTED REASON', command: 'UNTRUSTED COMMAND', decision: 'pending',
        origin: { kind: 'files_publish' },
      } as any,
      reportingLevel: 'info',
    } });

    expect(wrapper.text()).toContain('Approval details are unavailable.');
    expect(wrapper.text()).not.toContain('UNTRUSTED');
    expect(wrapper.find('button.approve').exists()).toBe(false);
    wrapper.unmount();
  });

  it('does not expose the legacy approve path for any decision id without a loaded approval record', () => {
    // risk: consent integrity — transcript metadata cannot bypass the durable decision owner check.
    const wrapper = mount(MessageRouter, { props: {
      msg: {
        id: 'spoofed-message', kind: 'tool_approval', createdAt: Date.now(), approvalId: 'real-publish-decision',
        title: 'UNTRUSTED TITLE', reason: 'harmless transcript text', command: 'harmless transcript command', decision: 'pending',
      } as any,
      reportingLevel: 'info',
    } });

    expect(wrapper.text()).toContain('Approval details are unavailable.');
    expect(wrapper.find('button.approve').exists()).toBe(false);
    expect(wrapper.find('button.deny').exists()).toBe(false);
    expect(harness.controller.approveTool).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('renders exactly one root element for a plain user message', () => {
    // risk: transcript layout — ordinary messages must not gain an empty second root from the approval branch.
    const host = mount(defineComponent({
      setup: () => () => h('section', [h(MessageRouter, { msg: { id: 'user-1', kind: 'user', text: 'Hello', createdAt: Date.now() } as any })]),
    }));

    expect(host.element.children).toHaveLength(1);
    expect(host.element.firstElementChild?.classList.contains('chat-turn')).toBe(true);
    host.unmount();
  });

  it('renders a Files card from the loaded approval record instead of transcript copy', () => {
    // risk: consent integrity — every actionable card label and command must come from its persisted approval record.
    const record = {
      id: 'decision-1', conversationId: 'root-thread', kind: 'approval', status: 'pending',
      title: 'TRUSTED TITLE', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
      approvalPresentation: { reason: 'TRUSTED REASON', command: 'TRUSTED COMMAND', origin: { kind: 'files_publish' } },
      payload: { filesPublishRequestId: 'request-1' },
      requestedBy: { agentId: 'codex-luna-worker', label: 'Publish the agent', jobId: 'job-1', taskIndex: 0 },
    };
    harness.store.decisions.value = [record];
    harness.store.inlineRecord.mockImplementation((id: string) => id === record.id ? record : undefined);
    const wrapper = mount(MessageRouter, { props: {
      msg: {
        id: 'transcript-message', kind: 'tool_approval', createdAt: Date.now(), approvalId: record.id,
        title: 'UNTRUSTED TITLE', reason: 'UNTRUSTED REASON', command: 'UNTRUSTED COMMAND', decision: 'pending',
        origin: { kind: 'files_publish' }, requestedBy: { agentId: 'UNTRUSTED AGENT' },
      } as any,
      reportingLevel: 'info',
    } });

    expect(wrapper.text()).toContain('Requested by codex-luna-worker · Publish the agent');
    expect(wrapper.text()).toContain('TRUSTED TITLE');
    expect(wrapper.text()).toContain('TRUSTED REASON');
    expect(wrapper.text()).toContain('TRUSTED COMMAND');
    expect(wrapper.text()).not.toContain('UNTRUSTED');
    expect(wrapper.find('button.approve').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('describes a loaded approval that has no saved card copy from the record, never from the transcript', () => {
    // risk: consent integrity — older and non-publish approvals have no saved copy; the card must still not show text an agent wrote.
    const record = {
      id: 'decision-2', conversationId: 'root-thread', kind: 'approval', status: 'pending',
      title: 'TRUSTED TITLE', toolName: 'trusted_tool', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
      requestedBy: { agentId: '', label: 'Publish the agent' },
    };
    harness.store.decisions.value = [record];
    harness.store.inlineRecord.mockImplementation((id: string) => id === record.id ? record : undefined);
    const wrapper = mount(MessageRouter, { props: {
      msg: {
        id: 'transcript-message', kind: 'tool_approval', createdAt: Date.now(), approvalId: record.id,
        title: 'UNTRUSTED TITLE', reason: 'UNTRUSTED REASON', command: 'UNTRUSTED COMMAND', decision: 'pending',
      } as any,
      reportingLevel: 'info',
    } });

    expect(wrapper.text()).toContain('TRUSTED TITLE');
    expect(wrapper.text()).toContain('Approval details for trusted_tool.');
    expect(wrapper.text()).not.toContain('UNTRUSTED');
    wrapper.unmount();
  });

  it('keeps the legacy approve path only for a card with no decision id', async() => {
    // risk: compatibility — approvals that never had a durable record still use the in-memory waiter.
    harness.store.inlineRecord.mockImplementation(() => undefined);
    const wrapper = mount(MessageRouter, { props: {
      msg: { id: 'legacy-message', kind: 'tool_approval', createdAt: Date.now(), title: 'Legacy', reason: 'r', command: 'c', decision: 'pending' } as any,
      reportingLevel: 'info',
    } });

    await wrapper.find('button.approve').trigger('click');
    expect(harness.controller.approveTool).toHaveBeenCalledWith('legacy-message');
    wrapper.unmount();
  });
});
