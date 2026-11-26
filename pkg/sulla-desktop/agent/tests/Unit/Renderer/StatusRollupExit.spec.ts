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
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
  else Reflect.deleteProperty(document, 'hidden');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('StatusRollup trail exit', () => {
  // risk: missed/lingering activity — a displaced item must enter its leave animation and be removed when it ends.
  it('floats and fades displaced items with independent stagger/drift, then removes them', async() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      transform: 'matrix(1, 0, 0, 1, 0, 0)',
      transitionProperty: 'transform, opacity',
      transitionDuration: '0.42s, 0.7s',
      transitionDelay: '0.024s, 0s',
      getPropertyValue: () => '',
    } as CSSStyleDeclaration);
    const items: StatusRollupItem[] = Array.from({ length: 4 }, (_, index) => ({
      key: `item-${ index }`, threadId: 'thread-1', agentId: `agent-${ index }`, agentName: `Worker ${ index }`,
      text: `Work ${ index }`, observedAt: Date.now() + index,
    }));

    wrapper = mount(StatusRollup, {
      attachTo: document.body,
      props: { threadId: 'thread-1', checkIns: [items[0]!] },
      global: { stubs: { TransitionGroup: false } },
    });
    await nextTick();
    for (let count = 2; count <= items.length; count += 1) {
      await wrapper.setProps({ checkIns: items.slice(0, count) });
      await vi.advanceTimersByTimeAsync(1_300);
      await nextTick();
      if (count === 3) {
        const staged = Array.from(wrapper.element.querySelectorAll<HTMLElement>('.status-rollup__trail-item'));
        expect(staged.map(item => [item.style.getPropertyValue('--rollup-exit-stagger'), item.style.getPropertyValue('--rollup-exit-drift')]))
          .toEqual([['24ms', '-3px'], ['0ms', '3px']]);
      }
    }

    const leaving = wrapper.element.querySelector<HTMLElement>('.rollup-trail-leave-active');
    expect(leaving?.classList.contains('rollup-trail-leave-to')).toBe(true);
    expect(leaving?.textContent).toContain(items[0]!.text);
    expect(leaving?.style.getPropertyValue('--rollup-exit-stagger')).toBe('24ms');
    expect(leaving?.style.getPropertyValue('--rollup-exit-drift')).toBe('-3px');

    await vi.advanceTimersByTimeAsync(701);
    await nextTick();
    expect(wrapper.element.textContent).not.toContain(items[0]!.text);
  });
});
