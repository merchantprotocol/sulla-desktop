// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import {
  InfrastructureFailure,
  WorkerResourcePreflight,
  type MemorySpaceProbe,
  type SystemLoadProbe,
} from '@pkg/agent/services/WorkerResourcePreflight';

class FixedDiskProbe { constructor(private readonly bytes: number) {} async freeBytes(): Promise<number> { return this.bytes } }
class FixedLoadProbe implements SystemLoadProbe {
  constructor(private readonly loadAverage: number, private readonly cpuCount: number) {}
  async reading() { return { loadAverage: this.loadAverage, cpuCount: this.cpuCount } }
}
class FixedMemoryProbe implements MemorySpaceProbe { constructor(private readonly bytes: number) {} async freeBytes() { return this.bytes } }

const GiB = 1024 ** 3;

describe('WorkerResourcePreflight', () => {
  it('allows a launch exactly at the disk and load thresholds', async() => {
    // risk: healthy workers are refused at an inclusive resource boundary
    const preflight = new WorkerResourcePreflight(new FixedDiskProbe(2 * GiB), new FixedLoadProbe(8, 4));
    await expect(preflight.assertLaunchAllowed()).resolves.toBeUndefined();
  });

  it('refuses a launch below the configurable free-disk threshold with a typed failure', async() => {
    // risk: a worker starts on a full machine and loses unpushed work
    const preflight = new WorkerResourcePreflight(new FixedDiskProbe(1.1 * GiB), new FixedLoadProbe(0, 4));
    await expect(preflight.assertLaunchAllowed()).rejects.toMatchObject({
      failureType: 'infrastructure',
      reason: 'infrastructure: disk full (1.1 GiB free, need 2.0 GiB)',
    });
  });

  it('refuses load above twice the CPU count but allows the exact limit', async() => {
    // risk: launch storms compound an already overloaded guest
    const preflight = new WorkerResourcePreflight(new FixedDiskProbe(3 * GiB), new FixedLoadProbe(8.01, 4));
    await expect(preflight.assertLaunchAllowed()).rejects.toBeInstanceOf(InfrastructureFailure);
    await expect(preflight.assertLaunchAllowed()).rejects.toThrow('infrastructure: system load high');
  });

  it('checks an optional configurable memory floor', async() => {
    // risk: memory pressure kills a worker after it begins work
    const thresholds = { minimumFreeDiskBytes: 2 * GiB, maximumLoadPerCpu: 2, minimumFreeMemoryBytes: GiB };
    const preflight = new WorkerResourcePreflight(new FixedDiskProbe(3 * GiB), new FixedLoadProbe(0, 4), thresholds, new FixedMemoryProbe(0.5 * GiB));
    await expect(preflight.assertLaunchAllowed()).rejects.toMatchObject({ failureType: 'infrastructure' });
  });
});
