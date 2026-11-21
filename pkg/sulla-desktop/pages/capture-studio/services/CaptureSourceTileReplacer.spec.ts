// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { CaptureSourceTileReplacer } from './CaptureSourceTileReplacer';

describe('CaptureSourceTileReplacer', () => {
  it('replaces only the selected existing monitor tile', async() => {
    // risk: source isolation — changing one monitor must not add a tile or replace another stream.
    const tiles = [
      { id: 'screen', type: 'screen', name: 'Display 1', status: 'Capturing', on: true },
      { id: 'custom_screen', type: 'screen', name: 'Display 2', status: 'Capturing', on: true },
    ];
    const originalOther = { ...tiles[0] };
    const acquire = vi.fn(async() => ({}));
    const update = vi.fn();
    const replacer = new CaptureSourceTileReplacer(acquire, update);

    await replacer.replace(tiles[1], 'window:editor', 'Editor');

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith('custom_screen', 'window:editor');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toEqual(originalOther);
    expect(tiles[1]).toMatchObject({ id: 'custom_screen', name: 'Editor', status: 'Capturing', on: true });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('does not mutate the tile when acquiring the new source fails', async() => {
    // risk: stream custody — failed acquisition must preserve the currently selected live tile.
    const tile = { id: 'screen', type: 'screen', name: 'Display', status: 'Capturing', on: true };
    const replacer = new CaptureSourceTileReplacer(async() => { throw new Error('permission denied'); }, vi.fn());

    await expect(replacer.replace(tile, 'window:editor', 'Editor')).rejects.toThrow('permission denied');
    expect(tile).toEqual({ id: 'screen', type: 'screen', name: 'Display', status: 'Capturing', on: true });
  });
});
