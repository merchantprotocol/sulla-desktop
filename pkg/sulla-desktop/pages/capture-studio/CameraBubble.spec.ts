// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import CameraBubble from './CameraBubble.vue';

describe('CameraBubble context menu source wiring', () => {
  it('emits the exact screen ID from a screen assigned to the bubble', async() => {
    const wrapper = mount(CameraBubble, {
      props: {
        cameraStream: null,
        recording: false,
        cameraShape: 'circle',
        currentLayout: 'pip',
        pipSource: { id: 'screen:secondary', type: 'screen' },
        pausedSources: {},
      },
    });

    await wrapper.find('.cam-bubble').trigger('contextmenu');

    expect(wrapper.emitted('show-screen-menu')?.[0]?.[1]).toBe('screen:secondary');
    wrapper.unmount();
  });

  it('pauses, resumes, and removes the exact camera or screen assigned to the bubble', async() => {
    for (const source of [
      { id: 'camera:usb-9', type: 'camera', name: 'Webcam' },
      { id: 'screen:window-2', type: 'screen', name: 'Window' },
    ]) {
      const wrapper = mount(CameraBubble, {
        props: {
          cameraStream: null, recording: false, cameraShape: 'circle', currentLayout: 'pip',
          pipSource: source, pausedSources: {},
        },
      });
      await wrapper.get(`[aria-label="Pause ${source.name}"]`).trigger('click');
      expect(wrapper.emitted('toggle-pause')?.[0]?.[0]).toBe(source.id);
      await wrapper.setProps({ pausedSources: { [source.id]: true } });
      expect(wrapper.get(`[aria-label="Resume ${source.name}"]`).exists()).toBe(true);
      await wrapper.get(`[aria-label="Resume ${source.name}"]`).trigger('click');
      expect(wrapper.emitted('toggle-pause')?.[1]?.[0]).toBe(source.id);
      await wrapper.get(`[aria-label="Remove ${source.name}"]`).trigger('click');
      expect(wrapper.emitted('remove-source')?.[0]?.[0]).toBe(source.id);
      expect(wrapper.find('.cam-bubble').exists()).toBe(true);
      wrapper.unmount();
    }
  });
});
