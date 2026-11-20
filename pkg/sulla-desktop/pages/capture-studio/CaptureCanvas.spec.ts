// @vitest-environment jsdom
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
        pausedSources: {},
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
        pausedSources: {},
        channels: [],
      },
    });

    await wrapper.find('.audio-only-display').trigger('contextmenu');

    expect(wrapper.emitted('show-audio-menu')?.[0]?.[1]).toBe('system');
    wrapper.unmount();
  });

  it('pauses, resumes, and removes only the selected live screen, camera, mic, or system tile', async() => {
    const channels = [
      { id: 'screen:window-7', type: 'screen', name: 'Window' },
      { id: 'camera:usb-2', type: 'camera', name: 'Camera' },
      { id: 'mic:usb-3', type: 'mic', name: 'Microphone' },
      { id: 'system:default', type: 'system', name: 'System audio' },
    ];
    const wrapper = mount(CaptureCanvas, {
      props: {
        screenStream: null, cameraStream: null, currentLayout: 'sidebyside',
        primarySource: null, pipSource: null, audioOnlySources: 'Microphone + System audio',
        audioOnlySourceId: 'mic:usb-3', channels, pausedSources: {},
      },
    });

    for (const channel of channels) {
      const tile = wrapper.findAll('.sbs-tile').find(item => item.text().includes(channel.name));
      expect(tile, `tile for ${channel.id} remains visible`).toBeTruthy();
      await tile!.get(`[aria-label="Pause ${channel.name}"]`).trigger('click');
      expect(wrapper.emitted('toggle-pause')?.at(-1)?.[0]).toBe(channel.id);
      expect(wrapper.emitted('remove-source')).toBeUndefined();
      await wrapper.setProps({ pausedSources: { [channel.id]: true } });
      expect(tile!.find(`[aria-label="Resume ${channel.name}"]`).exists()).toBe(true);
      await tile!.get(`[aria-label="Resume ${channel.name}"]`).trigger('click');
      expect(wrapper.emitted('toggle-pause')?.at(-1)?.[0]).toBe(channel.id);
      await tile!.get(`[aria-label="Remove ${channel.name}"]`).trigger('click');
      expect(wrapper.emitted('remove-source')?.at(-1)?.[0]).toBe(channel.id);
      expect(tile!.exists()).toBe(true);
    }
    expect(wrapper.emitted('toggle-pause')).toHaveLength(channels.length * 2);
    expect(wrapper.emitted('remove-source')).toHaveLength(channels.length);
    wrapper.unmount();
  });

  it('keeps every mic and system source controllable in audio-only layout', async() => {
    const wrapper = mount(CaptureCanvas, {
      props: {
        screenStream: null, cameraStream: null, currentLayout: 'audioonly',
        primarySource: null, pipSource: null, audioOnlySources: 'Microphone + System audio',
        audioOnlySourceId: 'mic:primary', pausedSources: {},
        channels: [
          { id: 'mic:primary', type: 'mic', name: 'Microphone' },
          { id: 'system:loopback', type: 'system', name: 'System audio' },
        ],
      },
    });

    for (const id of ['mic:primary', 'system:loopback']) {
      await wrapper.find(`[aria-label="Pause ${id === 'mic:primary' ? 'Microphone' : 'System audio'}"]`).trigger('click');
      expect(wrapper.emitted('toggle-pause')?.at(-1)?.[0]).toBe(id);
      await wrapper.find(`[aria-label="Remove ${id === 'mic:primary' ? 'Microphone' : 'System audio'}"]`).trigger('click');
      expect(wrapper.emitted('remove-source')?.at(-1)?.[0]).toBe(id);
    }
    wrapper.unmount();
  });

  it('uses the exact assigned source ID for full-size preview controls', async() => {
    const wrapper = mount(CaptureCanvas, {
      props: {
        screenStream: null, cameraStream: null, currentLayout: 'screenonly',
        primarySource: { id: 'screen:display-4', type: 'screen', name: 'Display' },
        pipSource: null, audioOnlySources: '', audioOnlySourceId: '', channels: [], pausedSources: {},
      },
    });
    await wrapper.find('[aria-label="Pause Display"]').trigger('click');
    await wrapper.find('[aria-label="Remove Display"]').trigger('click');
    expect(wrapper.emitted('toggle-pause')?.[0]?.[0]).toBe('screen:display-4');
    expect(wrapper.emitted('remove-source')?.[0]?.[0]).toBe('screen:display-4');
    wrapper.unmount();
  });
});
