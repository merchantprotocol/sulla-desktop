// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as childProcess from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { Clock } from '@sulla/foundation';
import { SULLA_FILES_GUEST_MOUNT_PATH } from '@pkg/backend/guestMountInfo';

const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
/**
 * Mirrors the single rslave bind AgentContainerLauncher's
 * `sullaFilesGuestBinds()` produces today. Keep both in sync; Story 4 wires
 * this planner in and can then delete the duplicate in the launcher.
 */
const FILES_GUEST_BIND = `${ SULLA_FILES_GUEST_MOUNT_PATH }:${ SULLA_FILES_GUEST_MOUNT_PATH }:rslave`;
const UNAVAILABLE_REASON_MAX_LENGTH = 200;

export interface GuestCommandResult {
  code:   number;
  stdout: string;
  stderr: string;
}

export interface GuestCommandRunOptions {
  timeoutMs?: number;
}

/** Runs a command inside the guest VM. The bind path is a guest path, so the probe must run here, not on the host. */
export interface GuestCommandRunner {
  run(argv: string[], options?: GuestCommandRunOptions): Promise<GuestCommandResult>;
}

export type GuestProcessSpawner = (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;

/** Delegates to the same `sulla-runtime exec` mechanism AgentContainerLauncher's `guestExec()` uses. */
export class SullaRuntimeGuestCommandRunner implements GuestCommandRunner {
  constructor(
    private readonly sullaRuntimeBinaryPath: string,
    private readonly spawn: GuestProcessSpawner = childProcess.spawn,
  ) {}

  run(argv: string[], options: GuestCommandRunOptions = {}): Promise<GuestCommandResult> {
    return new Promise(resolve => {
      const proc = this.spawn(this.sullaRuntimeBinaryPath, ['exec', '--', ...argv]);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = options.timeoutMs !== undefined
        ? setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, options.timeoutMs)
        : undefined;

      proc.stdout.on('data', chunk => { stdout += String(chunk) });
      proc.stderr.on('data', chunk => { stderr += String(chunk) });
      proc.once('error', error => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr || error.message });
      });
      proc.once('close', code => {
        clearTimeout(timer);
        resolve(timedOut
          ? { code: -1, stdout, stderr: stderr.trim() || 'guest command timed out' }
          : { code: code ?? -1, stdout, stderr });
      });
      proc.stdin.end();
    });
  }
}

export interface SullaFilesMountAvailability {
  available: boolean;
  reason?:   string;
}

/** Read-only view of SullaFilesMountManager the probe needs; avoids coupling to the whole manager. */
export interface MountAvailabilityView {
  guestMountAvailable(): boolean;
}

export interface MountHealthCheck {
  check(): Promise<SullaFilesMountAvailability>;
}

/**
 * Confirms the Sulla Files guest bind is actually usable, not just flagged so.
 * The manager's `guestMountAvailable()` flag is a cached intent ("the backend
 * last confirmed the shared anchor"); it can stay true while the mount itself
 * has gone dead underneath it (e.g. a FUSE adapter that died leaves ENOTCONN
 * at the path). This probe exercises the guest path for real and caches the
 * outcome briefly so concurrent agent launches share one probe.
 */
export class SullaFilesMountHealthProbe implements MountHealthCheck {
  private cached?: SullaFilesMountAvailability;
  private cachedAt = 0;
  private pending?: Promise<SullaFilesMountAvailability>;

  constructor(
    private readonly mountManager: MountAvailabilityView,
    private readonly runner: GuestCommandRunner,
    private readonly clock: Clock,
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    private readonly probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    private readonly guestPath = SULLA_FILES_GUEST_MOUNT_PATH,
  ) {}

  async check(): Promise<SullaFilesMountAvailability> {
    if (!this.mountManager.guestMountAvailable()) {
      this.cached = undefined;
      return { available: false, reason: 'Sulla Files mount is not attached' };
    }

    const now = this.clock.now().getTime();
    if (this.cached && now - this.cachedAt < this.cacheTtlMs) return this.cached;
    if (this.pending) return this.pending;

    const pending = this.probeGuest().then(result => {
      this.cached = result;
      this.cachedAt = this.clock.now().getTime();
      return result;
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });

    this.pending = pending;
    return pending;
  }

  private async probeGuest(): Promise<SullaFilesMountAvailability> {
    // stat proves the path resolves at all; ls proves the FUSE adapter still
    // answers directory reads (a dead adapter can stat fine and hang on readdir).
    const result = await this.runner.run(
      ['sh', '-c', 'stat "$1" >/dev/null && ls -A "$1" >/dev/null', 'sh', this.guestPath],
      { timeoutMs: this.probeTimeoutMs },
    );
    if (result.code === 0) return { available: true };
    return { available: false, reason: result.stderr.trim() || `guest probe exited with code ${ result.code }` };
  }
}

export interface SullaFilesBindPlan {
  binds:    string[];
  env:      Record<string, string>;
  warning?: string;
}

/** Turns a mount health check into the binds/env an agent container launch should use. */
export class SullaFilesBindPlanner {
  constructor(private readonly probe: MountHealthCheck) {}

  async plan(): Promise<SullaFilesBindPlan> {
    const availability = await this.probe.check();

    if (availability.available) return { binds: [FILES_GUEST_BIND], env: { SULLA_FILES_AVAILABLE: '1' } };

    const reason = this.shortReason(availability.reason ?? 'unavailable');
    return {
      binds:   [],
      env:     { SULLA_FILES_AVAILABLE: '0', SULLA_FILES_UNAVAILABLE_REASON: reason },
      warning: `Sulla Files unavailable for this run: ${ reason }`,
    };
  }

  private shortReason(reason: string): string {
    const collapsed = reason.replace(/\s+/g, ' ').trim();
    return collapsed.length > UNAVAILABLE_REASON_MAX_LENGTH
      ? `${ collapsed.slice(0, UNAVAILABLE_REASON_MAX_LENGTH - 1) }…`
      : collapsed;
  }
}
