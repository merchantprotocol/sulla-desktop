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

export type WorkspaceRemovalReason = 'clean' | 'age' | 'disk';

export interface WorkspaceRemovalRecord {
  path:   string;
  jobId:  string;
  reason: WorkspaceRemovalReason;
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
  jobId:     string;
  mtimeMs:   number;
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

/**
 * Reclaims guest agent-job workspaces under GUEST_AGENT_WORKSPACES_ROOT that
 * are no longer needed: terminal jobs whose workspace carries no unpublished
 * content. A workspace the WorkspaceInspector calls unsafe is retained
 * forever regardless of age or disk pressure; only a safe workspace may be
 * swept once it crosses the retention window, or earlier if the guest disk
 * is running low. Deletion failures are recorded and never abort the run.
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
  ) {}

  async enforce(): Promise<WorkspaceRetentionReport> {
    const report: WorkspaceRetentionReport = { removed: [], keptUnsafe: [], bytesFreed: 0, errors: [] };
    const candidates = await this.listCandidates(report);
    const waitingForAge: WorkspaceCandidate[] = [];

    for (const candidate of candidates) {
      if (this.activeJobGuard.isActive(candidate.jobId)) continue;

      const inspection = await this.inspector.inspect(candidate.path).catch(error => ({
        status: 'unsafe' as const, reasons: [`inspection failed: ${ this.describe(error) }`], hasGitRepository: true,
      }));
      if (inspection.status === 'unsafe') {
        report.keptUnsafe.push({ path: candidate.path, jobId: candidate.jobId, reasons: inspection.reasons });
        continue;
      }

      if (!inspection.hasGitRepository) {
        await this.remove(candidate, 'clean', report);
        continue;
      }

      const ageMs = this.clock.now() - candidate.mtimeMs;
      if (ageMs >= this.config.retentionWindowMs) await this.remove(candidate, 'age', report);
      else waitingForAge.push(candidate);
    }

    if (waitingForAge.length) await this.reclaimUnderDiskPressure(waitingForAge, report);
    return report;
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
      const freed = await this.remover.remove(candidate.path);
      report.removed.push({ path: candidate.path, jobId: candidate.jobId, reason });
      if (freed !== undefined) report.bytesFreed += freed;
      return freed;
    } catch (error) {
      report.errors.push({ path: candidate.path, error: this.describe(error) });
      return undefined;
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
