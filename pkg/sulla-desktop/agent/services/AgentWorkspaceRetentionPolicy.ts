// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { WorkspaceFileSystem, WorkspaceInspector } from './AgentWorkspaceInspector';
import { WorkspaceRetentionConfig } from './AgentWorkspaceRetentionConfig';

/** Reports whether a job is still queued or running, without touching jobRegistry directly. */
export interface ActiveJobGuard {
  isActive(jobId: string): boolean;
}

export interface RetentionClock {
  now(): number;
}

export interface DiskSpaceProbe {
  freeBytes(): Promise<number>;
}

/** Deletes one workspace; may report bytes freed when that is cheap to know. */
export interface WorkspaceRemover {
  remove(path: string): Promise<number | undefined>;
}
export interface WorkspaceJobState { status: string; finishedAt?: number | null; waitingOnChildren?: number; }
export interface WorkspaceJobStateReader { state(jobId: string): Promise<WorkspaceJobState | undefined>; }
export interface WorkspaceRecoveryPreserver { preserve(path: string, jobId: string): Promise<string>; }

export type WorkspaceRemovalReason = 'clean' | 'age' | 'disk' | 'orphan';

export interface WorkspaceRemovalRecord {
  path:   string;
  jobId:  string;
  reason: WorkspaceRemovalReason;
  bytesFreed?: number;
}

export interface WorkspaceKeptUnsafeRecord {
  path:    string;
  jobId:   string;
  reasons: string[];
}

export interface WorkspaceRetentionErrorRecord {
  path:  string;
  error: string;
}

export interface WorkspaceRetentionReport {
  removed:    WorkspaceRemovalRecord[];
  keptUnsafe: WorkspaceKeptUnsafeRecord[];
  bytesFreed: number;
  errors:     WorkspaceRetentionErrorRecord[];
}

interface WorkspaceCandidate {
  path:      string;
  lease?:    WorkspaceDeletionLease;
  jobId:     string;
  mtimeMs:   number;
  job?:      WorkspaceJobState;
  requiresPreservation?: boolean;
}

/**
 * A workspace directory name is `<jobKey>-<8 random chars>`, optionally
 * prefixed by `<repo>-<branch>-`, where jobKey is `<jobId>-<taskIndex>`
 * (see AgentContainerLauncher.ts `jobKey`/`prepareCheckout` and
 * GuestRuntimeTransport.ts `seedGitWorktreeIntoGuest`/`createGuestRuntimeDirectory`).
 * Observed job ids all match `agent-job-<digits>-<digits>`; anchoring on that
 * literal lets this pattern find the jobId regardless of any repo/branch
 * prefix. If the job id scheme ever changes, this must change with it.
 */
const JOB_WORKSPACE_NAME_PATTERN = /(?:^|-)(agent-job-\d+-\d+)-\d+-[A-Za-z0-9]{8}$/;
const QUARANTINE_PREFIX = '.reclaiming-';

export interface WorkspaceDeletionLease {
  readonly inspectionPath: string;
  captureInspectionMarker(): Promise<void>;
  isUnchangedSinceInspection(): Promise<boolean>;
  release(): Promise<void>;
  consumed(): void;
}

export interface WorkspaceDeletionLeaseProvider {
  acquire(workspacePath: string, expectedMtimeMs: number): Promise<WorkspaceDeletionLease | undefined>;
  restoreOrphan(quarantinedPath: string): Promise<void>;
}

/** Same-filesystem rename lease: no other retention pass can claim the original path. */
export class AtomicRenameWorkspaceDeletionLeaseProvider implements WorkspaceDeletionLeaseProvider {
  constructor(private readonly fileSystem: WorkspaceFileSystem) {}

  async acquire(workspacePath: string, expectedMtimeMs: number): Promise<WorkspaceDeletionLease | undefined> {
    const claimedPath = `${ workspacePath.slice(0, workspacePath.lastIndexOf('/') + 1) }${ QUARANTINE_PREFIX }${ workspacePath.slice(workspacePath.lastIndexOf('/') + 1) }`;
    await this.fileSystem.rename(workspacePath, claimedPath);
    const claimedStat = await this.fileSystem.lstat(claimedPath);
    if (claimedStat.mtimeMs !== expectedMtimeMs) {
      await this.fileSystem.rename(claimedPath, workspacePath);
      return undefined;
    }
    return new AtomicRenameWorkspaceDeletionLease(this.fileSystem, workspacePath, claimedPath);
  }

  async restoreOrphan(quarantinedPath: string): Promise<void> {
    const name = quarantinedPath.slice(quarantinedPath.lastIndexOf('/') + 1);
    const originalPath = `${ quarantinedPath.slice(0, quarantinedPath.lastIndexOf('/') + 1) }${ name.slice(QUARANTINE_PREFIX.length) }`;
    await this.fileSystem.rename(quarantinedPath, originalPath);
  }
}

class AtomicRenameWorkspaceDeletionLease implements WorkspaceDeletionLease {
  readonly inspectionPath: string;
  private inspectionMtimeMs?: number;
  private consumedLease = false;

  constructor(
    private readonly fileSystem: WorkspaceFileSystem,
    private readonly originalPath: string,
    claimedPath: string,
  ) { this.inspectionPath = claimedPath }

  async captureInspectionMarker(): Promise<void> {
    this.inspectionMtimeMs = (await this.fileSystem.lstat(this.inspectionPath)).mtimeMs;
  }

  async isUnchangedSinceInspection(): Promise<boolean> {
    if (this.inspectionMtimeMs === undefined) return false;
    return (await this.fileSystem.lstat(this.inspectionPath)).mtimeMs === this.inspectionMtimeMs;
  }

  async release(): Promise<void> {
    if (!this.consumedLease) await this.fileSystem.rename(this.inspectionPath, this.originalPath);
  }

  consumed(): void { this.consumedLease = true }
}

/**
 * Reclaims guest agent-job workspaces under GUEST_AGENT_WORKSPACES_ROOT that
 * are no longer needed: terminal jobs whose workspace carries no unpublished
 * content. A workspace the WorkspaceInspector calls unsafe is retained
 * forever regardless of age or disk pressure; only a safe workspace may be
 * swept once it crosses the retention window, or earlier if the guest disk
 * is running low. A non-git workspace only skips the window when it is
 * literally empty; any file inside it waits the same window as a git
 * checkout. Candidates are atomically renamed inside the same root before
 * inspection. A resuming job then fails loudly instead of writing into a
 * directory being deleted. The active guard is rechecked after this claim;
 * unsafe or failed claims are restored, and failed restores stay quarantined.
 */
export class AgentWorkspaceRetentionPolicy {
  constructor(
    private readonly rootPath:        string,
    private readonly fileSystem:      WorkspaceFileSystem,
    private readonly inspector:       WorkspaceInspector,
    private readonly activeJobGuard:  ActiveJobGuard,
    private readonly clock:           RetentionClock,
    private readonly diskSpaceProbe:  DiskSpaceProbe,
    private readonly remover:         WorkspaceRemover,
    private readonly config = new WorkspaceRetentionConfig(),
    private readonly leases: WorkspaceDeletionLeaseProvider = new AtomicRenameWorkspaceDeletionLeaseProvider(fileSystem),
    private readonly jobs?: WorkspaceJobStateReader,
    private readonly recovery?: WorkspaceRecoveryPreserver,
  ) {}

  async enforce(): Promise<WorkspaceRetentionReport> {
    const report: WorkspaceRetentionReport = { removed: [], keptUnsafe: [], bytesFreed: 0, errors: [] };
    const candidates = await this.listCandidates(report);
    const waitingForAge: WorkspaceCandidate[] = [];

    for (const candidate of candidates) {
      candidate.job = await this.readJob(candidate);
      if (!candidate.job || this.isProtected(candidate.job) || this.activeJobGuard.isActive(candidate.jobId)) continue;

      try {
        candidate.lease = await this.leases.acquire(candidate.path, candidate.mtimeMs);
      } catch (error) {
        report.errors.push({ path: candidate.path, error: `failed to claim workspace: ${ this.describe(error) }` });
      }
      if (!candidate.lease) continue;
      const refreshed = await this.readJob(candidate);
      if (!refreshed || this.isProtected(refreshed) || this.activeJobGuard.isActive(candidate.jobId)) {
        await this.restore(candidate, report);
        continue;
      }
      candidate.job = refreshed;

      const inspection = await this.inspector.inspect(candidate.lease.inspectionPath).catch(error => ({
        status: 'unsafe' as const, reasons: [`inspection failed: ${ this.describe(error) }`], hasGitRepository: true,
      }));
      try {
        await candidate.lease.captureInspectionMarker();
      } catch (error) {
        report.errors.push({ path: candidate.path, error: `failed to capture inspection marker: ${ this.describe(error) }` });
        await this.restore(candidate, report);
        continue;
      }
      const job = await this.readJob(candidate);
      if (!job || this.isProtected(job) || this.activeJobGuard.isActive(candidate.jobId)) {
        await this.restore(candidate, report);
        continue;
      }
      const finishedAt = candidate.job.finishedAt ?? candidate.mtimeMs;
      const ageMs = this.clock.now() - finishedAt;
      const completedDue = candidate.job.status === 'completed' && ageMs >= this.config.completedRetentionMs;
      const terminalDue = candidate.job.status !== 'completed' && ageMs >= this.config.terminalRetentionMs;
      candidate.requiresPreservation = inspection.status === 'unsafe' || !inspection.hasGitRepository;
      const empty = !inspection.hasGitRepository && await this.isEmptyDirectory(candidate.lease.inspectionPath, report);
      if (inspection.status === 'unsafe' && (!terminalDue || !this.jobs)) {
        report.keptUnsafe.push({ path: candidate.path, jobId: candidate.jobId, reasons: inspection.reasons });
        await this.restore(candidate, report);
        continue;
      }
      if ((completedDue && inspection.status === 'clean') || empty) {
        await this.remove(candidate, empty ? 'clean' : 'age', report);
        continue;
      }
      if (terminalDue) {
        if (this.jobs && (inspection.status === 'unsafe' || !inspection.hasGitRepository) && !await this.preserve(candidate, report)) continue;
        await this.remove(candidate, candidate.job.status === 'orphan' ? 'orphan' : 'age', report);
      } else waitingForAge.push(candidate);
    }

    if (waitingForAge.length) await this.reclaimUnderDiskPressure(waitingForAge, report);
    for (const candidate of waitingForAge) {
      if (candidate.lease) await this.restore(candidate, report);
    }
    return report;
  }

  /** Only a workspace with literally nothing inside it may skip the age window; any content waits like a git checkout. */
  private async isEmptyDirectory(path: string, report: WorkspaceRetentionReport): Promise<boolean> {
    try {
      const names = await this.fileSystem.readdir(path);
      return names.length === 0;
    } catch (error) {
      report.errors.push({ path, error: this.describe(error) });
      return false;
    }
  }

  private async listCandidates(report: WorkspaceRetentionReport): Promise<WorkspaceCandidate[]> {
    let names: string[];
    try {
      names = await this.fileSystem.readdir(this.rootPath);
    } catch (error) {
      report.errors.push({ path: this.rootPath, error: this.describe(error) });
      return [];
    }

    const candidates: WorkspaceCandidate[] = [];
    for (const name of names) {
      if (name.startsWith(QUARANTINE_PREFIX)) {
        await this.restoreLeftover(name, report);
        continue;
      }
      const childPath = `${ this.rootPath }/${ name }`;
      let stat;
      try {
        stat = await this.fileSystem.lstat(childPath);
      } catch (error) {
        report.errors.push({ path: childPath, error: this.describe(error) });
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const match = JOB_WORKSPACE_NAME_PATTERN.exec(name);
      if (!match) continue;
      candidates.push({ path: childPath, jobId: match[1], mtimeMs: stat.mtimeMs });
    }
    return candidates;
  }

  /** A crashed pass never turns a prior quarantine into a deletion candidate. */
  private async restoreLeftover(name: string, report: WorkspaceRetentionReport): Promise<void> {
    const quarantinedPath = `${ this.rootPath }/${ name }`;
    try {
      await this.leases.restoreOrphan(quarantinedPath);
    } catch (error) {
      report.errors.push({ path: quarantinedPath, error: `failed to restore quarantined workspace: ${ this.describe(error) }` });
    }
  }

  private async restore(candidate: WorkspaceCandidate, report: WorkspaceRetentionReport): Promise<void> {
    if (!candidate.lease) return;
    const claimedPath = candidate.lease.inspectionPath;
    try {
      await candidate.lease.release();
      candidate.lease = undefined;
    } catch (error) {
      report.errors.push({ path: claimedPath, error: `failed to restore workspace: ${ this.describe(error) }` });
    }
  }

  private async reclaimUnderDiskPressure(
    waitingForAge: WorkspaceCandidate[],
    report: WorkspaceRetentionReport,
  ): Promise<void> {
    let freeBytes: number;
    try {
      freeBytes = await this.diskSpaceProbe.freeBytes();
    } catch (error) {
      report.errors.push({ path: this.rootPath, error: this.describe(error) });
      return;
    }
    if (freeBytes >= this.config.minFreeDiskBytes) return;

    const oldestFirst = [...waitingForAge].sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const candidate of oldestFirst) {
      if (freeBytes >= this.config.minFreeDiskBytes) break;
      if (candidate.requiresPreservation && this.jobs && !await this.preserve(candidate, report)) continue;
      const freed = await this.remove(candidate, 'disk', report);
      if (freed === undefined) {
        try {
          freeBytes = await this.diskSpaceProbe.freeBytes();
        } catch (error) {
          report.errors.push({ path: this.rootPath, error: this.describe(error) });
          break;
        }
      } else {
        freeBytes += freed;
      }
    }
  }

  private async remove(
    candidate: WorkspaceCandidate,
    reason: WorkspaceRemovalReason,
    report: WorkspaceRetentionReport,
  ): Promise<number | undefined> {
    try {
      const job = await this.readJob(candidate);
      if (!job || this.isProtected(job) || this.activeJobGuard.isActive(candidate.jobId)) {
        await this.restore(candidate, report);
        return undefined;
      }
      if (!candidate.lease) throw new Error('workspace was not atomically claimed');
      if (!await candidate.lease.isUnchangedSinceInspection()) {
        report.errors.push({ path: candidate.path, error: 'workspace changed after inspection; deletion refused' });
        await this.restore(candidate, report);
        return undefined;
      }
      const freed = await this.remover.remove(candidate.lease.inspectionPath);
      candidate.lease.consumed();
      candidate.lease = undefined;
      report.removed.push({ path: candidate.path, jobId: candidate.jobId, reason, ...(freed === undefined ? {} : { bytesFreed: freed }) });
      if (freed !== undefined) report.bytesFreed += freed;
      return freed;
    } catch (error) {
      report.errors.push({ path: candidate.path, error: this.describe(error) });
      await this.restore(candidate, report);
      return undefined;
    }
  }

  private async readJob(candidate: WorkspaceCandidate): Promise<WorkspaceJobState | undefined> {
    if (!this.jobs) return candidate.job ?? { status: 'completed', finishedAt: candidate.mtimeMs };
    const registered = await this.jobs.state(candidate.jobId);
    if (registered) return registered;
    if (this.clock.now() - candidate.mtimeMs < this.config.terminalRetentionMs) return undefined;
    return { status: 'orphan', finishedAt: candidate.mtimeMs };
  }

  private isProtected(job: WorkspaceJobState): boolean {
    return !['completed', 'failed', 'stopped', 'orphan'].includes(job.status) || (job.waitingOnChildren ?? 0) > 0;
  }

  private async preserve(candidate: WorkspaceCandidate, report: WorkspaceRetentionReport): Promise<boolean> {
    if (!candidate.lease || !this.recovery) {
      report.keptUnsafe.push({ path: candidate.path, jobId: candidate.jobId, reasons: ['recovery preservation unavailable'] });
      await this.restore(candidate, report);
      return false;
    }
    try { await this.recovery.preserve(candidate.lease.inspectionPath, candidate.jobId); return true; }
    catch (error) {
      report.errors.push({ path: candidate.path, error: `recovery preservation failed: ${ this.describe(error) }` });
      await this.restore(candidate, report);
      return false;
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
