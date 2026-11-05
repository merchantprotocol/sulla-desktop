// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DiskSpaceProbe } from './AgentContainerRetentionPolicy';
import type { GuestCommandRunner } from './GuestDiskSpaceProbe';

export interface SystemLoadReading { loadAverage: number; cpuCount: number }
export interface SystemLoadProbe { reading(): Promise<SystemLoadReading> }
export interface MemorySpaceProbe { freeBytes(): Promise<number> }

export interface WorkerResourceThresholds {
  minimumFreeDiskBytes: number;
  maximumLoadPerCpu: number;
  minimumFreeMemoryBytes?: number;
}

export const DEFAULT_WORKER_RESOURCE_THRESHOLDS: Readonly<WorkerResourceThresholds> = Object.freeze({
  minimumFreeDiskBytes: 2 * 1024 * 1024 * 1024,
  maximumLoadPerCpu: 2,
});

export class InfrastructureFailure extends Error {
  readonly failureType = 'infrastructure' as const;

  constructor(readonly reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'InfrastructureFailure';
  }
}

/** Reads the one-minute guest load average and online CPU count. */
export class GuestSystemLoadProbe implements SystemLoadProbe {
  constructor(private readonly runner: GuestCommandRunner) {}

  async reading(): Promise<SystemLoadReading> {
    const [load, cpus] = await Promise.all([
      this.runner.run(['cat', '/proc/loadavg']),
      this.runner.run(['nproc']),
    ]);
    const loadAverage = Number(load.stdout.trim().split(/\s+/)[0]);
    const cpuCount = Number(cpus.stdout.trim());
    if (!Number.isFinite(loadAverage) || !Number.isInteger(cpuCount) || cpuCount < 1) {
      throw new InfrastructureFailure('infrastructure: unable to read guest system load');
    }
    return { loadAverage, cpuCount };
  }
}

/** Refuses worker launches before they consume more resources on an unhealthy guest. */
export class WorkerResourcePreflight {
  constructor(
    private readonly disk: DiskSpaceProbe,
    private readonly load: SystemLoadProbe,
    private readonly thresholds: WorkerResourceThresholds = DEFAULT_WORKER_RESOURCE_THRESHOLDS,
    private readonly memory?: MemorySpaceProbe,
  ) {}

  async assertLaunchAllowed(): Promise<void> {
    const freeDiskBytes = await this.disk.freeBytes();
    if (freeDiskBytes < this.thresholds.minimumFreeDiskBytes) {
      throw new InfrastructureFailure(`infrastructure: disk full (${ this.gib(freeDiskBytes) } GiB free, need ${ this.gib(this.thresholds.minimumFreeDiskBytes) } GiB)`);
    }

    const { loadAverage, cpuCount } = await this.load.reading();
    const maximumLoad = this.thresholds.maximumLoadPerCpu * cpuCount;
    if (loadAverage > maximumLoad) {
      throw new InfrastructureFailure(`infrastructure: system load high (${ loadAverage.toFixed(2) }, maximum ${ maximumLoad.toFixed(2) } for ${ cpuCount } CPUs)`);
    }

    if (this.memory && this.thresholds.minimumFreeMemoryBytes !== undefined) {
      const freeMemoryBytes = await this.memory.freeBytes();
      if (freeMemoryBytes < this.thresholds.minimumFreeMemoryBytes) {
        throw new InfrastructureFailure(`infrastructure: memory low (${ this.gib(freeMemoryBytes) } GiB free, need ${ this.gib(this.thresholds.minimumFreeMemoryBytes) } GiB)`);
      }
    }
  }

  private gib(bytes: number): string { return (bytes / (1024 ** 3)).toFixed(1) }
}
