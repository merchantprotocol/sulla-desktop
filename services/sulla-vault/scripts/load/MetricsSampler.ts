// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { LoadReport } from './Report.js';
import { ProcessHandleReader, type ProcessHandles } from './TestAssets.js';
import type { TestVaultInstance } from './TestVaultInstance.js';

interface NodeMemoryUsage { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers?: number }

export interface ResourceSample {
  elapsedSeconds: number;
  vaultRssMiB: number | null;
  vaultHeapUsedMiB: number | null;
  vaultHeapTotalMiB: number | null;
  clientRssMiB: number;
  vaultHandles: ProcessHandles;
  clientHandles: ProcessHandles;
}

export interface ResourceSummary {
  sampleCount: number;
  vaultRssPeakMiB: number | null;
  vaultHeapUsedPeakMiB: number | null;
  vaultHeapTotalPeakMiB: number | null;
  clientRssPeakMiB: number;
  clientCpuMs: number;
  clientCpuPercent: number;
  vaultHandlesBefore: ProcessHandles;
  vaultHandlesAfter: ProcessHandles;
  clientHandlesBefore: ProcessHandles;
  clientHandlesAfter: ProcessHandles;
  samples: ResourceSample[];
}

/** Samples process memory and descriptor counts without taking any container or cgroup action. */
export class MetricsSampler {
  private readonly processHandles = new ProcessHandleReader();
  private readonly samples: ResourceSample[] = [];
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private startedAtNs = 0n;
  private clientCpuStart?: NodeJS.CpuUsage;
  private vaultHandlesBefore: ProcessHandles = { fdCount: null, socketCount: null };
  private clientHandlesBefore: ProcessHandles = { fdCount: null, socketCount: null };
  private vaultHandlesAfter: ProcessHandles = { fdCount: null, socketCount: null };
  private clientHandlesAfter: ProcessHandles = { fdCount: null, socketCount: null };
  private clientRssPeak = 0;

  constructor(private readonly vault: TestVaultInstance, private readonly intervalMs = 1_000) {}

  async start(): Promise<void> {
    this.startedAtNs = process.hrtime.bigint();
    this.clientCpuStart = process.cpuUsage();
    // Warm the telemetry connection so before/after socket counts compare the same sampling path.
    await this.vault.readMetrics();
    this.vaultHandlesBefore = await this.readVaultHandles();
    this.clientHandlesBefore = await this.processHandles.read(process.pid);
    await this.sample();
    this.timer = setInterval(() => { void this.sample(); }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<ResourceSummary> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending?.catch(() => undefined);
    await this.sample();
    this.vaultHandlesAfter = await this.readVaultHandles();
    this.clientHandlesAfter = await this.processHandles.read(process.pid);
    const elapsedMs = Number(process.hrtime.bigint() - this.startedAtNs) / 1_000_000;
    const cpu = this.clientCpuStart ? process.cpuUsage(this.clientCpuStart) : { user: 0, system: 0 };
    const clientCpuMs = (cpu.user + cpu.system) / 1_000;
    const vaultRss = this.samples.map(sample => sample.vaultRssMiB).filter((value): value is number => value !== null);
    const heapUsed = this.samples.map(sample => sample.vaultHeapUsedMiB).filter((value): value is number => value !== null);
    const heapTotal = this.samples.map(sample => sample.vaultHeapTotalMiB).filter((value): value is number => value !== null);
    return {
      sampleCount: this.samples.length,
      vaultRssPeakMiB: vaultRss.length ? Math.max(...vaultRss) : null,
      vaultHeapUsedPeakMiB: heapUsed.length ? Math.max(...heapUsed) : null,
      vaultHeapTotalPeakMiB: heapTotal.length ? Math.max(...heapTotal) : null,
      clientRssPeakMiB: LoadReport.mib(this.clientRssPeak) ?? 0,
      clientCpuMs: LoadReport.round(clientCpuMs),
      clientCpuPercent: elapsedMs > 0 ? LoadReport.round(100 * clientCpuMs / elapsedMs) : 0,
      vaultHandlesBefore: this.vaultHandlesBefore,
      vaultHandlesAfter: this.vaultHandlesAfter,
      clientHandlesBefore: this.clientHandlesBefore,
      clientHandlesAfter: this.clientHandlesAfter,
      samples: this.samples,
    };
  }

  private async sample(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.capture().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async capture(): Promise<void> {
    const elapsedSeconds = LoadReport.round(Number(process.hrtime.bigint() - this.startedAtNs) / 1e9, 1);
    const clientMemory = process.memoryUsage();
    this.clientRssPeak = Math.max(this.clientRssPeak, clientMemory.rss);
    let memory: NodeMemoryUsage | undefined;
    const pid = await this.vault.pid;
    if (pid) {
      try {
        const metrics = await this.vault.readMetrics();
        memory = metrics.memory as NodeMemoryUsage;
      } catch { /* process may be in OOM/exit; /proc status still supplies RSS below */ }
    }
    const vaultHandles = pid ? await this.processHandles.read(pid) : { fdCount: null, socketCount: null };
    const clientHandles = await this.processHandles.read(process.pid);
    const procRss = await this.readProcRss(pid);
    this.samples.push({
      elapsedSeconds,
      vaultRssMiB: LoadReport.mib(memory?.rss ?? procRss),
      vaultHeapUsedMiB: LoadReport.mib(memory?.heapUsed),
      vaultHeapTotalMiB: LoadReport.mib(memory?.heapTotal),
      clientRssMiB: LoadReport.mib(clientMemory.rss) ?? 0,
      vaultHandles,
      clientHandles,
    });
  }

  private async readVaultHandles(): Promise<ProcessHandles> {
    const pid = this.vault.pid;
    return pid ? this.processHandles.read(pid) : { fdCount: null, socketCount: null };
  }

  private async readProcRss(pid: number | undefined): Promise<number | null> {
    if (!pid) return null;
    try {
      const { readFile } = await import('node:fs/promises');
      const status = await readFile(`/proc/${ pid }/status`, 'utf8');
      const kb = Number(/^VmRSS:\s+(\d+) kB/m.exec(status)?.[1] ?? NaN);
      return Number.isFinite(kb) ? kb * 1024 : null;
    } catch { return null; }
  }
}
