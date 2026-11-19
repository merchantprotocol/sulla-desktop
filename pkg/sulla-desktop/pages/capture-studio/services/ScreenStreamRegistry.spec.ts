// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { ScreenStreamRegistry } from './ScreenStreamRegistry';

function fakeStream() {
  const stop = vi.fn();
  return { stream: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop };
}

describe('ScreenStreamRegistry', () => {
  it('keeps each source independent and releases only the requested stream', () => {
    // risk: resource lifecycle — removing one display must not stop another display's recording/preview.
    const registry = new ScreenStreamRegistry();
    const first = fakeStream();
    const second = fakeStream();
    registry.set('screen', first.stream);
    registry.set('custom_2', second.stream);

    registry.release('custom_2');

    expect(first.stop).not.toHaveBeenCalled();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(registry.get('screen')).toBe(first.stream);
    expect(registry.get('custom_2')).toBeNull();
  });

  it('stops a replaced stream and all remaining streams on teardown', () => {
    // risk: resource lifecycle — repeated source selection and window teardown must not leak captures.
    const registry = new ScreenStreamRegistry();
    const oldStream = fakeStream();
    const replacement = fakeStream();
    const other = fakeStream();
    registry.set('screen', oldStream.stream);
    registry.set('screen', replacement.stream);
    registry.set('custom_3', other.stream);
    registry.releaseAll();

    expect(oldStream.stop).toHaveBeenCalledOnce();
    expect(replacement.stop).toHaveBeenCalledOnce();
    expect(other.stop).toHaveBeenCalledOnce();
    expect(registry.entries()).toEqual([]);
  });
});
