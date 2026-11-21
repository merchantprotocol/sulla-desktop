// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PlaybackTile from './PlaybackTile.vue';

describe('PlaybackTile controls', () => {
  it.each<[string, boolean]>([
    ['screen', true], ['camera', true], ['mic', false], ['system-audio', false],
  ])('wires keyboard-accessible pause/play, close, native controls and context menu for %s', async(type, isVideo) => {
    // risk: playback control — every recorded media type must expose isolated, keyboard reachable per-tile actions.
    const wrapper = mount(PlaybackTile, {
      props: { stream: { id: `${ type }-1`, type, filePath: '/session/track.webm', isVideo }, label: type, color: 'red', paused: true },
    });
    const playPause = wrapper.get('button[aria-label^="Play"]');
    expect(playPause.attributes('type')).toBe('button');
    await playPause.trigger('focus');
    await playPause.trigger('click');
    await wrapper.get('button[aria-label^="Close"]').trigger('click');
    await wrapper.get('.playback-tile').trigger('contextmenu');
    await wrapper.get(isVideo ? 'video' : 'audio').trigger('play');
    await wrapper.get(isVideo ? 'video' : 'audio').trigger('pause');

    expect(wrapper.emitted('toggle')?.[0]).toEqual([`${ type }-1`]);
    expect(wrapper.emitted('close')?.[0]).toEqual([`${ type }-1`]);
    expect(wrapper.emitted('context-menu')?.[0]?.[1]).toBe(`${ type }-1`);
    expect(wrapper.emitted('play')?.[0]).toEqual([`${ type }-1`]);
    expect(wrapper.emitted('pause')?.[0]).toEqual([`${ type }-1`]);
    wrapper.unmount();
  });
});
