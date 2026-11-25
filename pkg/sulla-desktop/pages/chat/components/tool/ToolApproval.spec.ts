// @vitest-environment jsdom
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

const controller = vi.hoisted(() => ({ approveTool: vi.fn(), denyTool: vi.fn() }));
vi.mock('../../controller/useChatController', () => ({ useChatController: () => controller }));

import ToolApproval from './ToolApproval.vue';

const title = "Activate agent 'coding-manager' v1.0.0?";

describe('ToolApproval publish card', () => {
  afterEach(() => { vi.clearAllMocks() });

  it('shows the decision title, expiry, approve/deny controls, and opens Decide', async() => {
    // risk: user consent — the review must be visible and resolvable in the originating chat.
    const expiresAt = Date.now() + 30 * 60_000;
    const decide = vi.fn(async() => undefined);
    const wrapper = mount(ToolApproval, { props: {
      msg: { id: 'msg-1', kind: 'tool_approval', createdAt: Date.now(), title, reason: 'Publish this Files draft.', command: 'Files draft publication', decision: 'pending', approvalId: 'decision-1', expiresAt } as any,
      decide,
      showDecideLink: true,
    } });
    const selectedModes: string[] = [];
    const onMode = (event: Event) => selectedModes.push((event as CustomEvent<{ mode: string }>).detail.mode);
    window.addEventListener('sulla:mode-rail-select', onMode);

    expect(wrapper.text()).toContain(title);
    expect(wrapper.text()).toContain('Expires');
    expect(wrapper.find('button.approve').exists()).toBe(true);
    expect(wrapper.find('button.deny').exists()).toBe(true);
    await wrapper.get('button.approve').trigger('click');
    await wrapper.get('button.open-decide').trigger('click');

    expect(decide).toHaveBeenCalledWith('approved');
    expect(selectedModes).toEqual(['decide']);
    window.removeEventListener('sulla:mode-rail-select', onMode);
    wrapper.unmount();
  });

  it('shows expired and removes decision buttons once the 30-minute deadline has passed', () => {
    // risk: irreversible side effects — an expired approval cannot be approved from a stale transcript.
    const wrapper = mount(ToolApproval, { props: {
      msg: { id: 'msg-2', kind: 'tool_approval', createdAt: Date.now() - 31 * 60_000, title, reason: 'Publish this Files draft.', command: 'Files draft publication', decision: 'pending', approvalId: 'decision-2', expiresAt: Date.now() - 1 } as any,
      showDecideLink: true,
    } });

    expect(wrapper.text()).toContain('Expired');
    expect(wrapper.find('button.approve').exists()).toBe(false);
    expect(wrapper.find('button.deny').exists()).toBe(false);
    wrapper.unmount();
  });

  it('uses the shared clock to expire the card without a per-card timer', async() => {
    // risk: irreversible side effects — an approval must become unavailable as soon as the shared decision clock reaches its deadline.
    const expiresAt = 10_000;
    const wrapper = mount(ToolApproval, { props: {
      msg: { id: 'msg-clock', kind: 'tool_approval', createdAt: 1, title, reason: 'Publish this Files draft.', command: 'Files draft publication', decision: 'pending', approvalId: 'decision-clock', expiresAt } as any,
      now: expiresAt - 1,
    } });

    expect(wrapper.text()).not.toContain('Expired');
    await wrapper.setProps({ now: expiresAt });

    expect(wrapper.text()).toContain('Expired');
    expect(wrapper.find('button.approve').exists()).toBe(false);
    expect(wrapper.find('button.deny').exists()).toBe(false);
    wrapper.unmount();
  });

  it.each([
    { requestedBy: { label: 'Publish the agent' } },
    { requestedBy: { agentId: 'Publish the agent', label: 'Publish the agent' } },
  ])('renders a requester label only once when the agent id is missing or identical', ({ requestedBy }) => {
    // risk: user clarity — requester identity must not appear duplicated on approval cards.
    const wrapper = mount(ToolApproval, { props: {
      msg: { id: 'msg-requester', kind: 'tool_approval', createdAt: 1, title, reason: 'Publish this Files draft.', command: 'Files draft publication', decision: 'pending', requestedBy } as any,
    } });

    expect(wrapper.find('.requester').text()).toBe('Requested by Publish the agent');
    wrapper.unmount();
  });
});
