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
      },
    });

    await wrapper.find('.cam-bubble').trigger('contextmenu');

    expect(wrapper.emitted('show-screen-menu')?.[0]?.[1]).toBe('screen:secondary');
    wrapper.unmount();
  });
});
