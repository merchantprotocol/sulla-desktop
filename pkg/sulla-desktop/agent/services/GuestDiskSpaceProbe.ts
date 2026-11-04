// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import childProcess from 'node:child_process';
import type { DiskSpaceProbe } from './AgentContainerRetentionPolicy';

/**
 * The Docker data root inside the guest VM. Confirmed in
 * src/runtime-agent/datadisk.go: the guest's data disk is bind-mounted so
 * `var/lib/docker` on the data disk appears at `/var/lib/docker` in the
 * guest — the same path AgentContainerLauncher's `GuestDockerRuntimeDriver`
 * already assumes when it shells `docker` into the guest.
 */
export const GUEST_DOCKER_DATA_ROOT = '/var/lib/docker';

/** Runs one command inside the guest VM and returns its stdout. Mirrors `guestExec` in AgentContainerLauncher.ts. */
export interface GuestCommandRunner {
  run(args: string[]): Promise<{ stdout: string }>;
}

/**
 * Real `GuestCommandRunner`: shells `<sullaRuntimeBinary> exec -- <args>`,
 * the same invocation `guestExec` in AgentContainerLauncher.ts uses to run
 * `docker` commands inside the guest VM.
 */
export class SullaRuntimeCommandRunner implements GuestCommandRunner {
  constructor(private readonly sullaRuntimeBinary: string) {}

  run(args: string[]): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const proc = childProcess.spawn(this.sullaRuntimeBinary, ['exec', '--', ...args], {
        env:   { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', chunk => { stdout += String(chunk) });
      proc.stderr.on('data', chunk => { stderr += String(chunk) });
      proc.once('error', error => reject(new Error(`sulla-runtime exec ${ args[0] } failed to start: ${ error.message }`)));
      proc.once('close', code => {
        if (code === 0) resolve({ stdout });
        else reject(new Error(`sulla-runtime exec ${ args[0] } exited ${ code }: ${ stderr.trim() || 'no stderr' }`));
      });
    });
  }
}

/**
 * Real `DiskSpaceProbe`: runs `df -B1 --output=avail <path>` in the guest VM
 * and parses the single numeric line it prints under the header.
 */
export class GuestDiskSpaceProbe implements DiskSpaceProbe {
  constructor(
    private readonly runner: GuestCommandRunner,
    private readonly path:   string = GUEST_DOCKER_DATA_ROOT,
  ) {}

  async freeBytes(): Promise<number> {
    const { stdout } = await this.runner.run(['df', '-B1', '--output=avail', this.path]);
    const lines = stdout.trim().split('\n').map(line => line.trim()).filter(Boolean);
    const value = Number(lines[lines.length - 1]);
    if (!Number.isFinite(value)) {
      throw new Error(`GuestDiskSpaceProbe: could not parse 'df' output for ${ this.path }: ${ JSON.stringify(stdout) }`);
    }
    return value;
  }
}
