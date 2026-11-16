// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import TurnActions from '@pkg/pages/chat/components/transcript/TurnActions.vue';

describe('actions under a Sulla reply', () => {
  // risk: the buttons floated over the next message and vanished on the way to them
  it('sit in their own row with labels for Copy and Reply and named icons for the rest', () => {
    const row = mount(TurnActions, { props: { role: 'sulla' } });

    expect(row.classes()).toContain('tact-sulla');
    expect(row.findAll('.tact-btn').map(b => b.text() || b.attributes('aria-label'))).toEqual(['Copy', 'Reply', 'Regenerate', 'Pin', 'Fork into a new chat']);
  });

  it('stay visible on the newest reply only', () => {
    expect(mount(TurnActions, { props: { role: 'sulla', latest: true } }).classes()).toContain('tact-latest');
    expect(mount(TurnActions, { props: { role: 'sulla' } }).classes()).not.toContain('tact-latest');
  });

  it('confirm a copy in place, then go back', async() => {
    vi.useFakeTimers();
    const row = mount(TurnActions, { props: { role: 'sulla' } });
    const copy = row.find('.tact-btn');

    await copy.trigger('click');
    expect(row.emitted('copy')).toHaveLength(1);
    expect(copy.text()).toBe('Copied');

    vi.advanceTimersByTime(1300);
    await row.vm.$nextTick();
    expect(copy.text()).toBe('Copy');
    vi.useRealTimers();
  });

  it('show whether the reply is pinned', () => {
    const pin = mount(TurnActions, { props: { role: 'sulla', pinned: true } }).find('[aria-label="Unpin"]');
    expect(pin.attributes('aria-pressed')).toBe('true');
  });

  it('offer Edit and Copy under your own message', () => {
    const row = mount(TurnActions, { props: { role: 'you' } });
    expect(row.findAll('.tact-btn').map(b => b.text())).toEqual(['Edit', 'Copy']);
  });
});
