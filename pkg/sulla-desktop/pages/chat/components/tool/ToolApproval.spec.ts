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
});
