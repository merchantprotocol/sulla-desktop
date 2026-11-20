// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { PlaybackTileController } from './PlaybackTileController';

describe('PlaybackTileController', () => {
  it.each(['screen', 'camera', 'mic', 'system-audio'])('isolates pause/play/close for %s tiles', type => {
    // risk: playback isolation — operating on one audio/video source must not affect another tile.
    const first = { paused: true, play: vi.fn(async() => {}), pause: vi.fn() };
    const other = { paused: false, play: vi.fn(async() => {}), pause: vi.fn() };
    const elements: Record<string, typeof first> = { [`${ type }-1`]: first, [`${ type }-2`]: other };
    const removed = vi.fn();
    const setPaused = vi.fn();
    const pausedState: Record<string, boolean> = { [`${ type }-1`]: true, [`${ type }-2`]: false };
    const controller = new PlaybackTileController(id => elements[id], removed, id => pausedState[id], (id, paused) => { pausedState[id] = paused; setPaused(id, paused); });

    controller.toggle(`${ type }-1`);
    expect(first.play).toHaveBeenCalledTimes(1);
    expect(controller.isPaused(`${ type }-1`)).toBe(false);
    expect(other.pause).not.toHaveBeenCalled();
    controller.close(`${ type }-1`);
    expect(first.pause).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith(`${ type }-1`);
    expect(other.pause).not.toHaveBeenCalled();
  });

  it('returns the tile to paused state when autoplay is rejected', async() => {
    // risk: playback state — denied autoplay must keep the tile control accurate and retryable.
    const element = { paused: true, play: vi.fn().mockRejectedValue(new Error('autoplay denied')), pause: vi.fn() };
    let paused = true;
    const controller = new PlaybackTileController(() => element, vi.fn(), () => paused, (_id, value) => { paused = value; });
    controller.toggle('mic');
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.isPaused('mic')).toBe(true);
  });
});
