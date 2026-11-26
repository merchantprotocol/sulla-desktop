// @vitest-environment jsdom
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

vi.mock('@pkg/composables/useFocusGuard', () => ({ useFocusGuard: vi.fn() }));

import ComposerInput from '@pkg/pages/chat/components/composer/ComposerInput.vue';

let wrapper: VueWrapper | undefined;
let layoutWidth = 0;
let observerCallback: ResizeObserverCallback | undefined;
let observedElement: Element | undefined;
let disconnected = false;
const prototypeProperties = ['getBoundingClientRect', 'clientWidth', 'clientHeight', 'offsetHeight', 'scrollHeight'] as const;
let originalProperties = new Map<typeof prototypeProperties[number], PropertyDescriptor | undefined>();

class ResizeObserverFixture {
  constructor(callback: ResizeObserverCallback) { observerCallback = callback; }
  observe(target: Element): void { observedElement = target; }
  disconnect(): void { disconnected = true; }
}

beforeEach(() => {
  layoutWidth = 0;
  observerCallback = undefined;
  observedElement = undefined;
  disconnected = false;
  originalProperties = new Map(prototypeProperties.map(name => [name, Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, name)]));
  Object.defineProperties(HTMLTextAreaElement.prototype, {
    getBoundingClientRect: { configurable: true, value: () => ({ width: layoutWidth, height: layoutWidth ? 24 : 0, top: 0, right: layoutWidth, bottom: layoutWidth ? 24 : 0, left: 0, x: 0, y: 0, toJSON: () => ({}) }) },
    clientWidth: { configurable: true, get: () => layoutWidth },
    clientHeight: { configurable: true, get: () => layoutWidth ? 24 : 0 },
    offsetHeight: { configurable: true, get: () => layoutWidth ? 24 : 0 },
    scrollHeight: { configurable: true, get: () => layoutWidth ? 24 : 220 },
  });
  vi.stubGlobal('ResizeObserver', ResizeObserverFixture);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  for (const [name, descriptor] of originalProperties) {
    if (descriptor) Object.defineProperty(HTMLTextAreaElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLTextAreaElement.prototype, name);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ComposerInput initial sizing', () => {
  // risk: first-paint usability — a hidden chat tab must not freeze a wrapped zero-width measurement into the input height.
  it('sizes to one row when a hidden mounted input becomes visible', async() => {
    wrapper = mount(ComposerInput, { props: { modelValue: '', placeholder: 'Message Sulla' } });
    const input = wrapper.get('textarea').element as HTMLTextAreaElement;
    await nextTick();

    expect(observedElement).toBe(input);
    expect(input.style.height).toBe('');

    layoutWidth = 240;
    observerCallback?.([
      { target: input, contentRect: { width: layoutWidth, height: 24 } as DOMRectReadOnly } as ResizeObserverEntry,
    ], new ResizeObserverFixture(() => undefined) as unknown as ResizeObserver);
    await nextTick();

    expect(input.style.height).toBe('24px');
    expect(input.style.overflowY).toBe('hidden');
    wrapper.unmount();
    wrapper = undefined;
    expect(disconnected).toBe(true);
  });
});
