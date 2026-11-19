// SPDX-License-Identifier: GPL-2.0-or-later
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { lazyScreen } from '../lazyScreen';

const LoadedScreen = defineComponent({
  name:   'LoadedScreen',
  render: () => h('div', { class: 'loaded-screen' }, 'screen ready'),
});

describe('lazyScreen', () => {
  it('shows a Retry pane instead of a blank tab when the chunk fails, and Retry loads it', async () => {
    // risk: blank-tab regression — a failed chunk must leave a recoverable pane, not nothing.
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('chunk load failed'))
      .mockResolvedValueOnce({ default: LoadedScreen });
    const Screen = lazyScreen(loader, 'FixtureScreen');

    const wrapper = mount(Screen);
    await flushPromises();

    expect(wrapper.text()).toContain('This screen failed to load.');
    const retry = wrapper.find('button');
    expect(retry.exists()).toBe(true);

    await retry.trigger('click');
    await flushPromises();

    expect(loader).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.loaded-screen').exists()).toBe(true);
  });

  it('renders the loaded screen without an error pane on success', async () => {
    // risk: first-paint regression — a healthy chunk must render straight through.
    const loader = vi.fn().mockResolvedValue({ default: LoadedScreen });
    const wrapper = mount(lazyScreen(loader, 'FixtureScreen'));
    await flushPromises();

    expect(loader).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('screen ready');
    expect(wrapper.text()).not.toContain('This screen failed to load.');
  });
});
