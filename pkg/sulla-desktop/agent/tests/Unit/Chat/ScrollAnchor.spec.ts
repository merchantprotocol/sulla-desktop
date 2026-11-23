// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { expect, it } from 'vitest';
import { defineComponent, ref } from 'vue';

import { useScrollAnchor } from '@pkg/pages/chat/composables/useScrollAnchor';

// risk: the jump affordance appears without user scrolling or vanishes while the reader is away from newest messages.
it('shows the jump affordance after a real upward scroll and clears it at the bottom', () => {
  const oldScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  const oldRequestAnimationFrame = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
  if (!oldScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value() {} });
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => { callback(performance.now()); return 1; },
  });

  const Reader = defineComponent({
    setup() {
      const scroller = ref<HTMLElement | null>(null);
      const { showPill } = useScrollAnchor(scroller, ref<unknown[]>([]));
      return { scroller, showPill };
    },
    template: '<div ref="scroller"></div>',
  });
  const reader = mount(Reader);
  const scroller = reader.element as HTMLElement;
  let scrollTop = 0;
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 500 },
    scrollTop: { configurable: true, get: () => scrollTop, set: value => { scrollTop = Number(value); } },
  });

  try {
    scroller.dispatchEvent(new Event('scroll'));
    expect(reader.vm.showPill).toBe(false);

    scroller.dispatchEvent(new Event('wheel'));
    scrollTop = 250;
    scroller.dispatchEvent(new Event('scroll'));
    expect(reader.vm.showPill).toBe(true);

    scrollTop = 450;
    scroller.dispatchEvent(new Event('scroll'));
    expect(reader.vm.showPill).toBe(false);
  } finally {
    reader.unmount();
    if (oldScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', oldScrollTo);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    if (oldRequestAnimationFrame) Object.defineProperty(window, 'requestAnimationFrame', oldRequestAnimationFrame);
    else Reflect.deleteProperty(window, 'requestAnimationFrame');
  }
});
