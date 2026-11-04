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
/** Kept shorter than DEFAULT_PROBE_TIMEOUT_MS so a `timeout`-equipped guest kills its own wedged process before the host's SIGKILL on the local relay fires. */
const DEFAULT_GUEST_TIMEOUT_SECONDS = 2;
/**
 * Mirrors the single rslave bind AgentContainerLauncher's
 * `sullaFilesGuestBinds()` produces today. Keep both in sync; Story 4 wires
 * this planner in and can then delete the duplicate in the launcher.
 */
const FILES_GUEST_BIND = `${ SULLA_FILES_GUEST_MOUNT_PATH }:${ SULLA_FILES_GUEST_MOUNT_PATH }:rslave`;
const UNAVAILABLE_REASON_MAX_LENGTH = 200;
/** Sentinel SullaRuntimeGuestCommandRunner reports when IT (not the guest) had to kill a hung process; probeGuest() turns this into a human reason. */
const HOST_TIMEOUT_SENTINEL = 'guest command timed out';

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
          ? { code: -1, stdout, stderr: stderr.trim() || HOST_TIMEOUT_SENTINEL }
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
    private readonly guestTimeoutSeconds = DEFAULT_GUEST_TIMEOUT_SECONDS,
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
    // A hung FUSE mount can block either call forever, which would otherwise
    // leave a stuck process in the guest on every launch and hang the launch
    // itself. We can't confirm every guest build ships GNU/BusyBox `timeout`
    // (the guest is a minimal custom erofs image; existing unmount code
    // already hedges between BusyBox and util-linux tools), so the script
    // probes for it at runtime and only wraps the commands when it's present.
    // Either way, the host-side `timeoutMs` below stays as the real backstop:
    // it kills the local relay process even if the guest has no `timeout`
    // binary, or the hang is itself unkillable (a process wedged in an
    // uninterruptible FUSE syscall).
    const script = [
      'p="$1"; t="$2";',
      'if command -v timeout >/dev/null 2>&1; then',
      '  timeout -s KILL "$t" stat "$p" >/dev/null && timeout -s KILL "$t" ls -A "$p" >/dev/null;',
      'else',
      '  stat "$p" >/dev/null && ls -A "$p" >/dev/null;',
      'fi',
    ].join(' ');

    const result = await this.runner.run(
      ['sh', '-c', script, 'sh', this.guestPath, String(this.guestTimeoutSeconds)],
      { timeoutMs: this.probeTimeoutMs },
    );
    if (result.code === 0) return { available: true };
    if (this.isTimeoutResult(result)) {
      return { available: false, reason: `Sulla Files probe timed out after ${ this.probeTimeoutMs / 1000 }s` };
    }
    return { available: false, reason: result.stderr.trim() || `guest probe exited with code ${ result.code }` };
  }

  /**
   * 124 is the GNU/BusyBox `timeout` convention for "timed out, signal not
   * propagated"; 137 is 128+SIGKILL. Either one with no stderr means our own
   * guest-side wrapper fired, not a real stat/ls failure.
   */
  private static readonly GUEST_SIDE_TIMEOUT_EXIT_CODES: ReadonlySet<number> = new Set([124, 137]);

  private isTimeoutResult(result: GuestCommandResult): boolean {
    if (result.code === -1) return result.stderr.trim() === HOST_TIMEOUT_SENTINEL;
    return SullaFilesMountHealthProbe.GUEST_SIDE_TIMEOUT_EXIT_CODES.has(result.code) && !result.stderr.trim();
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
