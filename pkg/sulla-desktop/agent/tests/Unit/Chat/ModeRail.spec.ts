// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ModeRail from '@pkg/pages/chat/components/chrome/ModeRail.vue';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);

    return 1;
  });
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the global mode rail', () => {
  it('keeps decisions inside the chat dock instead of exposing a duplicate global mode', () => {
    const wrapper = mount(ModeRail, { props: { active: 'chat' } });
    const labels = wrapper.findAll('.rail-items .mode-btn').map(button => button.attributes('aria-label'));

    expect(labels).toContain('Chat');
    expect(labels).not.toContain('Decide');
  });
});
