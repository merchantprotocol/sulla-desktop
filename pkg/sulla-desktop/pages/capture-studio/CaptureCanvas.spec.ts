import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import CaptureCanvas from './CaptureCanvas.vue';

describe('CaptureCanvas context menu source wiring', () => {
  it('emits the exact screen, mic, and system IDs from the live side-by-side tiles', async() => {
    const wrapper = mount(CaptureCanvas, {
      props: {
        screenStream: null,
        cameraStream: null,
        currentLayout: 'sidebyside',
        primarySource: null,
        pipSource: null,
        audioOnlySources: 'Microphone + System Audio',
        audioOnlySourceId: 'mic',
        channels: [
          { id: 'screen:secondary', type: 'screen', name: 'Second display' },
          { id: 'mic', type: 'mic', name: 'Microphone' },
          { id: 'system', type: 'system', name: 'System Audio' },
        ],
      },
    });

    const tiles = wrapper.findAll('.sbs-tile');
    await tiles[0].trigger('contextmenu');
    await tiles[1].trigger('contextmenu');
    await tiles[2].trigger('contextmenu');

    expect(wrapper.emitted('show-screen-menu')?.[0]?.[1]).toBe('screen:secondary');
    expect(wrapper.emitted('show-audio-menu')?.[0]?.[1]).toBe('mic');
    expect(wrapper.emitted('show-audio-menu')?.[1]?.[1]).toBe('system');
    wrapper.unmount();
  });

  it('emits the selected audio source from the aggregate audio-only preview', async() => {
    const wrapper = mount(CaptureCanvas, {
      props: {
        screenStream: null,
        cameraStream: null,
        currentLayout: 'audioonly',
        primarySource: null,
        pipSource: null,
        audioOnlySources: 'System Audio',
        audioOnlySourceId: 'system',
        channels: [],
      },
    });

    await wrapper.find('.audio-only-display').trigger('contextmenu');

    expect(wrapper.emitted('show-audio-menu')?.[0]?.[1]).toBe('system');
    wrapper.unmount();
  });
});
