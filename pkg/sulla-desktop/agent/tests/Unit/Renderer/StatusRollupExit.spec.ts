// @vitest-environment jsdom
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

import StatusRollup from '@pkg/pages/chat/components/composer/StatusRollup.vue';
import type { StatusRollupItem } from '@pkg/pages/chat/components/composer/StatusRollupQueue';

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const event = (key: string): StatusRollupItem => ({
  key,
  threadId: 'thread-1',
  agentId: `agent-${key}`,
  agentName: `Worker ${key}`,
  text: `Action ${key}`,
  observedAt: Date.now() + 1,
});

describe('StatusRollup ghost exit', () => {
  // risk: independent status exit — every displaced event must float/fade and be removed on its own duration.
  it('removes two ghosts independently at their individual durations', async() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0)
      .mockReturnValueOnce(.999999).mockReturnValueOnce(.999999).mockReturnValueOnce(.999999);
    wrapper = mount(StatusRollup, { props: { threadId: 'thread-1', checkIns: [] } });
    const first = event('one');
    const second = event('two');
    const third = event('three');

    await wrapper.setProps({ checkIns: [first] });
    await wrapper.setProps({ checkIns: [first, second] });
    await wrapper.setProps({ checkIns: [first, second, third] });
    await nextTick();

    const initial = Array.from(wrapper.element.querySelectorAll<HTMLElement>('.status-rollup__ghost'));
    expect(initial.map(ghost => ghost.textContent)).toEqual([
      expect.stringContaining(first.text), expect.stringContaining(second.text),
    ]);
    expect(initial[0]?.style.getPropertyValue('--rollup-dx')).toBe('-18px');
    expect(initial[0]?.style.getPropertyValue('--rollup-dy')).toBe('22px');
    expect(initial[0]?.style.getPropertyValue('--rollup-duration')).toBe('1500ms');
    expect(initial[1]?.style.getPropertyValue('--rollup-duration')).toBe('2600ms');

    await vi.advanceTimersByTimeAsync(1_500);
    await nextTick();
    expect(wrapper.text()).not.toContain(first.text);
    expect(wrapper.text()).toContain(second.text);

    await vi.advanceTimersByTimeAsync(1_099);
    await nextTick();
    expect(wrapper.text()).toContain(second.text);
    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    expect(wrapper.text()).not.toContain(second.text);
    expect(wrapper.text()).toContain(third.text);
  });

  // risk: reduced-motion accessibility — reduced motion ghosts fade quickly without spatial drift.
  it('uses a short stationary ghost when reduced motion is preferred', async() => {
    vi.useFakeTimers();
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
    wrapper = mount(StatusRollup, { props: { threadId: 'thread-1', checkIns: [] } });
    const first = event('one');
    const second = event('two');
    await wrapper.setProps({ checkIns: [first] });
    await wrapper.setProps({ checkIns: [first, second] });
    await nextTick();

    const ghost = wrapper.find('.status-rollup__ghost');
    expect(ghost.attributes('style')).toContain('--rollup-dx: 0px');
    expect(ghost.attributes('style')).toContain('--rollup-dy: 0px');
    expect(ghost.attributes('style')).toContain('--rollup-duration: 260ms');
    await vi.advanceTimersByTimeAsync(260);
    await nextTick();
    expect(wrapper.text()).not.toContain(first.text);

    window.matchMedia = originalMatchMedia;
  });
});
