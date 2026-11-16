// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { spawn as nodeSpawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';

/** What one guest `docker …` call produced. Never logged by the runner. */
export interface GuestDockerResult {
  /** Exit code; null when the process ended on a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A guest Docker runner that can feed stdin and reports the exit code instead of throwing on it. */
export interface StdinDockerCli {
  /**
   * Runs `docker <args>` in the guest. `input`, when given, is written to stdin
   * and stdin is closed. Resolves for any exit code; rejects only when the
   * process could not start or did not finish within the timeout.
   */
  run(args: string[], input?: string): Promise<GuestDockerResult>;
}

export type GuestSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Runs guest `docker` commands through the `sulla-runtime` binary without
 * logging anything: stdin and stdout may carry the service secret, so values
 * only ever travel on stdin (never in argv) and output is returned, not printed.
 *
 * Every call is bounded. A call that outlives the timeout is killed with
 * SIGKILL (a SIGTERM exit can read as success) and rejects.
 */
export class QuietGuestDockerStdin implements StdinDockerCli {
  static readonly DEFAULT_TIMEOUT_MS = 30_000;

  constructor(
    /** The `sulla-runtime` executable. */
    private readonly binary: string,
    /** Wraps a guest command into the binary's arguments (the backend's `guestExecArgs`). */
    private readonly guestArgs: (command: string[]) => string[],
    private readonly spawn: GuestSpawn = nodeSpawn,
    private readonly timeoutMs = QuietGuestDockerStdin.DEFAULT_TIMEOUT_MS,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  run(args: string[], input?: string): Promise<GuestDockerResult> {
    return new Promise<GuestDockerResult>((resolve, reject) => {
      let proc: ChildProcess;

      try {
        proc = this.spawn(this.binary, this.guestArgs(['docker', ...args]), { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        reject(error);

        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const finish = (outcome: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          outcome();
        }
      };
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        finish(() => reject(new Error(`docker ${ args[0] ?? '' } did not answer within ${ Math.round(this.timeoutMs / 1000) }s`)));
      }, this.timeoutMs);

      proc.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      proc.stdin?.on('error', () => { /* the exit code reports the failure */ });
      proc.on('error', error => finish(() => reject(error)));
      proc.on('close', code => finish(() => resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
      })));
      proc.stdin?.end(input);
    });
  }
}
