// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import type { CameraStreamService } from '../effects/CameraStreamService';
import { CameraStreamRegistry } from './CameraStreamRegistry';

describe('CameraStreamRegistry', () => {
  it('keeps camera service instances isolated by source and disposes all sessions at teardown', async() => {
    // risk: resource lifecycle — switching/removing one camera must not replace or stop another camera/effect session.
    const services = new Map<string, { dispose: () => Promise<void> }>();
    const registry = new CameraStreamRegistry((id) => {
      const service = { dispose: vi.fn().mockResolvedValue(undefined) };
      services.set(id, service);
      return service as unknown as CameraStreamService;
    });
    const first = registry.get('cam');
    const second = registry.get('custom_2');

    expect(registry.get('cam')).toBe(first);
    expect(second).not.toBe(first);
    await registry.disposeAll();

    expect(services.get('cam')?.dispose).toHaveBeenCalledOnce();
    expect(services.get('custom_2')?.dispose).toHaveBeenCalledOnce();
    expect(registry.values()).toEqual([]);
  });
});
