// @vitest-environment jsdom
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
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
  controller: {},
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
});
