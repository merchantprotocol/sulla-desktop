// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
//
// Keeps the guest VM from accumulating finished agent containers. On
// 2026-11-04 the VM data disk filled to 99%, the Sulla Files FUSE mount died,
// and every agent launch failed with a misleading "No such container" (the
// real error — the dead mount — was discarded by the `--rm` + retry path).
// This policy is the piece that stops disk pressure from building back up
// once failed containers are kept around for diagnosis instead of `--rm`'d.

import type { ContainerRuntimeDriver } from '@pkg/runtime/containerRuntime';

/** The label every agent workload container carries (AgentContainerLauncher.ts). */
export const AGENT_WORKLOAD_LABEL = 'com.sulla.workload';
export const AGENT_WORKLOAD_VALUE = 'agent';
const AGENT_WORKLOAD_LABEL_FILTER = `${ AGENT_WORKLOAD_LABEL }=${ AGENT_WORKLOAD_VALUE }`;

const PROTECTED_STATUSES = ['running', 'paused', 'restarting', 'removing'] as const;
const LIVE_JOB_STATUSES = ['running', 'parked', 'queued', 'waitingOnChildren'] as const;
const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'stopped', 'cancelled'] as const;
const UNKNOWN_OWNER_ORPHAN_AGE_MS = 24 * 60 * 60 * 1_000;

export interface DiskSpaceProbe { freeBytes(): Promise<number>; }
export interface Clock { now(): number; }

/** Lets the launcher shield containers of launches that are still in flight. */
export interface ActiveContainerGuard { isActive(containerId: string): boolean; }
export interface AgentJobStatusReader { status(jobId: string): Promise<string | undefined>; }

export type RemovalReason = 'age' | 'count' | 'disk' | 'expired' | 'terminal-owner' | 'pressure';

export interface RemovedContainer {
  id:     string;
  name:   string;
  reason: RemovalReason;
}

export interface RetentionError {
  stage:    'list' | 'agent-owner-list' | 'inspect' | 'remove' | 'disk-probe';
  id?:      string;
  message:  string;
}

export interface RetentionReport {
  removed:          RemovedContainer[];
  errors:           RetentionError[];
  /** Agent-labelled containers left after this run (protected ones plus any below every threshold). */
  keptCount:        number;
  freeBytesBefore:  number | null;
  freeBytesAfter:   number | null;
}

export interface RetentionConfigOverrides {
  maxAgeMs?:          number;
  maxKept?:           number;
  minFreeDiskBytes?:  number;
  createdGraceMs?:    number;
  intervalMs?:        number;
}

/** Value object for every tunable the policy and scheduler need. */
export class RetentionConfig {
  /** Finished containers older than this are removed regardless of disk pressure or count. */
  static readonly DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
  /** Keep at most this many finished agent containers, oldest removed first. */
  static readonly DEFAULT_MAX_KEPT = 10;
  /**
   * Never let guest free disk space drop below this. The VM data disk was at
   * 99% full on 2026-11-04 when the Sulla Files mount died; agent images and
   * per-run workspaces need real headroom so a launch failure can't itself
   * cause the next launch to fail from a full disk.
   */
  static readonly DEFAULT_MIN_FREE_DISK_BYTES = 5 * 1024 ** 3;
  /** A `created` (never started) container younger than this might still be mid-launch; leave it alone. */
  static readonly DEFAULT_CREATED_GRACE_MS = 10 * 60 * 1_000;
  /** How often the scheduler re-runs the policy. */
  static readonly DEFAULT_INTERVAL_MS = 15 * 60 * 1_000;

  readonly maxAgeMs:         number;
  readonly maxKept:          number;
  readonly minFreeDiskBytes: number;
  readonly createdGraceMs:   number;
  readonly intervalMs:       number;

  constructor(overrides: RetentionConfigOverrides = {}) {
    this.maxAgeMs         = overrides.maxAgeMs         ?? RetentionConfig.DEFAULT_MAX_AGE_MS;
    this.maxKept          = overrides.maxKept          ?? RetentionConfig.DEFAULT_MAX_KEPT;
    this.minFreeDiskBytes = overrides.minFreeDiskBytes ?? RetentionConfig.DEFAULT_MIN_FREE_DISK_BYTES;
    this.createdGraceMs   = overrides.createdGraceMs   ?? RetentionConfig.DEFAULT_CREATED_GRACE_MS;
    this.intervalMs       = overrides.intervalMs       ?? RetentionConfig.DEFAULT_INTERVAL_MS;
  }
}

interface DescribedContainer {
  id:        string;
  name:      string;
  status:    string;
  /** Finish time when known, else creation time — what "age" means for retention. */
  ageAtMs:   number;
  createdAtMs: number;
}

/** Docker's zero-time sentinel for a timestamp field that was never set. */
function parseDockerTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value || value.startsWith('0001-01-01')) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Enforces the guest VM's agent-container retention rules: remove containers
 * older than `maxAgeMs`, cap how many are kept, and shed the oldest first
 * when disk space runs low. Never touches a running, paused, restarting, or
 * guard-protected container, nor a freshly `created` one.
 */
export class ContainerRetentionPolicy {
  constructor(
    private readonly runtime:   ContainerRuntimeDriver,
    private readonly disk:      DiskSpaceProbe,
    private readonly clock:     Clock,
    private readonly guard:     ActiveContainerGuard,
    private readonly config:    RetentionConfig = new RetentionConfig(),
    private readonly jobs?:      AgentJobStatusReader,
  ) {}

  async enforce(): Promise<RetentionReport> {
    const removed: RemovedContainer[] = [];
    const errors: RetentionError[] = [];
    // A failed temporary-container pass is recorded but never skips the failed-container retention below.
    await this.reapAgentOwnedTemporaryContainers(removed, errors);

    let listed: any[];
    try {
      listed = await this.runtime.list(AGENT_WORKLOAD_LABEL_FILTER);
    } catch (error) {
      errors.push({ stage: 'list', message: errorMessage(error) });
      return { removed, errors, keptCount: 0, freeBytesBefore: null, freeBytesAfter: null };
    }

    const inspected: DescribedContainer[] = [];
    for (const entry of listed) {
      const listedId = entry?.ID ?? entry?.Id ?? entry?.Names;
      if (!listedId) continue;
      try {
        const details = await this.runtime.inspect(listedId);
        if (!this.hasAgentWorkloadLabel(details)) continue;
        inspected.push(this.describe(listedId, details));
      } catch (error) {
        errors.push({ stage: 'inspect', id: String(listedId), message: errorMessage(error) });
      }
    }

    const now = this.clock.now();
    const candidates: DescribedContainer[] = [];
    for (const container of inspected) {
      if (this.isProtected(container, now)) continue;
      candidates.push(container);
    }

    // (a) hard age cutoff, independent of count or disk pressure.
    const ageCutoff = now - this.config.maxAgeMs;
    for (const container of [...candidates]) {
      if (container.ageAtMs > ageCutoff) continue;
      if (await this.remove(container, 'age', removed, errors)) {
        candidates.splice(candidates.indexOf(container), 1);
      }
    }

    // (b) count cap, oldest first. A failed removal still drops out of the
    // candidate list for this run so one stuck container can't loop forever.
    candidates.sort((a, b) => a.ageAtMs - b.ageAtMs);
    while (candidates.length > this.config.maxKept) {
      const victim = candidates.shift()!;
      await this.remove(victim, 'count', removed, errors);
    }

    // (c) disk pressure, oldest first, re-probing after every removal.
    let freeBytesBefore: number | null = null;
    let freeBytesAfter: number | null = null;
    try {
      freeBytesBefore = await this.disk.freeBytes();
      let free = freeBytesBefore;
      while (free < this.config.minFreeDiskBytes && candidates.length > 0) {
        const victim = candidates.shift()!;
        await this.remove(victim, 'disk', removed, errors);
        try {
          free = await this.disk.freeBytes();
        } catch (error) {
          errors.push({ stage: 'disk-probe', message: errorMessage(error) });
          break;
        }
      }
      freeBytesAfter = free;
    } catch (error) {
      errors.push({ stage: 'disk-probe', message: errorMessage(error) });
    }

    return {
      removed,
      errors,
      keptCount: inspected.length - removed.length,
      freeBytesBefore,
      freeBytesAfter,
    };
  }

  private async reapAgentOwnedTemporaryContainers(removed: RemovedContainer[], errors: RetentionError[]): Promise<void> {
    let listed: any[];
    try {
      listed = await this.runtime.list('com.sulla.owner=agent');
    } catch (error) {
      errors.push({ stage: 'agent-owner-list', message: errorMessage(error) });
      return;
    }
    const nowSeconds = Math.floor(this.clock.now() / 1_000);
    const candidates: Array<{ container: DescribedContainer; labels: Record<string, string> }> = [];
    for (const entry of listed) {
      const listedId = entry?.ID ?? entry?.Id ?? entry?.Names;
      if (!listedId) continue;
      try {
        const details = await this.runtime.inspect(listedId);
        const labels = details?.Config?.Labels ?? {};
        if (labels['com.sulla.owner'] !== 'agent') continue;
        const container = this.describe(String(listedId), details);
        const persistent = labels['com.sulla.persistent'] === 'true';
        const expiresAt = Number(labels['com.sulla.expires-at']);
        const expired = Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= nowSeconds;
        const jobId = String(labels['com.sulla.job-id'] ?? '');
        const ownerStatus = await this.readOwnerStatus(jobId);
        if (!persistent && (expired || this.isTerminal(ownerStatus))) {
          const reason: RemovalReason = expired ? 'expired' : 'terminal-owner';
          if (await this.mayRemoveAgentOwned(container, jobId, nowSeconds * 1_000)) {
            await this.remove(container, reason, removed, errors);
          }
          continue;
        }
        if (!persistent && this.ownerCanBeReaped(ownerStatus, container, nowSeconds * 1_000)) {
          candidates.push({ container, labels });
        }
      } catch (error) {
        errors.push({ stage: 'inspect', id: String(listedId), message: errorMessage(error) });
      }
    }
    if (!candidates.length) return;
    try {
      let free = await this.disk.freeBytes();
      candidates.sort((a, b) => a.container.createdAtMs - b.container.createdAtMs);
      while (free < this.config.minFreeDiskBytes && candidates.length) {
        const victim = candidates.shift()!;
        const jobId = String(victim.labels['com.sulla.job-id'] ?? '');
        if (await this.mayRemoveAgentOwned(victim.container, jobId, this.clock.now())) {
          await this.remove(victim.container, 'pressure', removed, errors);
        }
        free = await this.disk.freeBytes();
      }
    } catch (error) {
      errors.push({ stage: 'disk-probe', message: errorMessage(error) });
    }
  }

  private async readOwnerStatus(jobId: string): Promise<string | undefined> {
    if (!jobId || !this.jobs) return undefined;
    try { return await this.jobs.status(jobId) } catch { return undefined }
  }

  private isTerminal(status: string | undefined): boolean {
    return !!status && (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
  }

  private ownerCanBeReaped(status: string | undefined, container: DescribedContainer, now: number): boolean {
    if (status && (LIVE_JOB_STATUSES as readonly string[]).includes(status)) return false;
    if (this.isTerminal(status)) return now - container.createdAtMs > this.config.createdGraceMs;
    return now - container.createdAtMs > UNKNOWN_OWNER_ORPHAN_AGE_MS && !PROTECTED_STATUSES.includes(container.status as any);
  }

  /** Re-inspects both container and owner immediately before rm; every uncertainty retains the container. */
  private async mayRemoveAgentOwned(container: DescribedContainer, jobId: string, now: number): Promise<boolean> {
    if (this.guard.isActive(container.id)) return false;
    let current: DescribedContainer;
    try {
      const details = await this.runtime.inspect(container.id);
      if (details?.Config?.Labels?.['com.sulla.owner'] !== 'agent') return false;
      current = this.describe(container.id, details);
    } catch { return false }
    if (this.guard.isActive(current.id) || (PROTECTED_STATUSES as readonly string[]).includes(current.status)) return false;
    return this.ownerCanBeReaped(await this.readOwnerStatus(jobId), current, now);
  }

  private hasAgentWorkloadLabel(details: any): boolean {
    const labels = details?.Config?.Labels ?? {};
    return labels[AGENT_WORKLOAD_LABEL] === AGENT_WORKLOAD_VALUE;
  }

  private describe(listedId: string, details: any): DescribedContainer {
    const id = details?.Id ?? listedId;
    const name = String(details?.Name ?? '').replace(/^\//, '') || id;
    const status = String(details?.State?.Status ?? 'unknown');
    const createdAtMs = parseDockerTimestamp(details?.Created) ?? 0;
    const finishedAtMs = parseDockerTimestamp(details?.State?.FinishedAt);
    return { id, name, status, createdAtMs, ageAtMs: finishedAtMs ?? createdAtMs };
  }

  private isProtected(container: DescribedContainer, now: number): boolean {
    if ((PROTECTED_STATUSES as readonly string[]).includes(container.status)) return true;
    if (this.guard.isActive(container.id)) return true;
    if (container.status === 'created' && now - container.createdAtMs < this.config.createdGraceMs) return true;
    return false;
  }

  /** Removes with `force=false`: every candidate here already passed the running/paused/restarting guard above. */
  private async remove(
    container: DescribedContainer,
    reason: RemovalReason,
    removed: RemovedContainer[],
    errors: RetentionError[],
    force = false,
  ): Promise<boolean> {
    try {
      await this.runtime.remove(container.id, force);
      removed.push({ id: container.id, name: container.name, reason });
      return true;
    } catch (error) {
      errors.push({ stage: 'remove', id: container.id, message: errorMessage(error) });
      return false;
    }
  }
}
