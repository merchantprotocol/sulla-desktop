// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type * as childProcess from 'node:child_process';

import { GuestDiskFullError } from './GuestDiskFullError';

/**
 * `sulla-runtime exec` exits 255 when the guest exec channel fails rather than
 * the command: the runtime is not reachable, the vsock stream closed early
 * (GuestExec.swift), or the guest agent lost the command to a signal and sent
 * exit -1 (runtime-agent exec.go). Those failures carry no stderr from the
 * command itself, only the runtime's own one-line notice, if any.
 */
const TRANSPORT_EXIT_CODE = 255;
const TRANSPORT_NOTICE = /^sulla-runtime: (guest connection closed|the runtime is not running)$/;

export type GuestExecFile = (
  file: string,
  args: string[],
  options: childProcess.ExecFileOptions & { encoding: 'utf8' },
  callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void,
) => childProcess.ChildProcess;

export interface GuestCommandRunnerOptions {
  runtimeBinary: () => string;
  execFile:      GuestExecFile;
  environment:   () => NodeJS.ProcessEnv;
  redact:        (text: string) => string;
  sleep?:        (ms: number) => Promise<void>;
  warn?:         (message: string) => void;
  /** Total tries for a transport-level 255; the guest steps it runs are idempotent. */
  attempts?:     number;
  retryDelayMs?: number;
}

/** A guest command that failed with an exit code; keeps the code and stderr for callers. */
export class GuestCommandError extends Error {
  constructor(message: string, readonly exitCode: number, readonly stderr: string) {
    super(message);
    this.name = 'GuestCommandError';
  }
}

/** Runs one bounded command in the Sulla guest and retries a lost exec channel once. */
export class GuestCommandRunner {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly attempts: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: GuestCommandRunnerOptions) {
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.attempts = Math.max(1, options.attempts ?? 2);
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  async run(args: string[], input: string | Buffer | undefined, timeoutMs: number): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(args, input, timeoutMs);
      } catch (error) {
        if (!(error instanceof GuestCommandError) || !GuestCommandRunner.isTransportFailure(error) || attempt >= this.attempts) {
          throw error;
        }
        this.options.warn?.(`[GuestRuntime] ${ error.message }; retrying (attempt ${ attempt + 1 }/${ this.attempts })`);
        await this.sleep(this.retryDelayMs);
      }
    }
  }

  static isTransportFailure(error: { exitCode?: unknown; stderr?: string }): boolean {
    const stderr = (error.stderr ?? '').trim();
    return error.exitCode === TRANSPORT_EXIT_CODE && (!stderr || TRANSPORT_NOTICE.test(stderr));
  }

  /** Name the guest step: the `sh -c` script label, or the executable. */
  private static label(args: string[]): string {
    return (args[0] === 'sh' && args[1] === '-c' && args[3]) ? args[3] : (args[0] ?? 'guest command');
  }

  private once(args: string[], input: string | Buffer | undefined, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let child: childProcess.ChildProcess;
      try {
        child = this.options.execFile(this.options.runtimeBinary(), ['exec', '--', ...args], {
          env:        this.options.environment(),
          encoding:   'utf8',
          maxBuffer:  8 * 1024 * 1024,
          timeout:    timeoutMs,
          killSignal: 'SIGKILL',
        }, (error, stdout, stderr) => {
          if (!error) {
            resolve(String(stdout ?? '').trim());
            return;
          }
          const exitCode = (error as { code?: unknown }).code;
          if (typeof exitCode !== 'number') {
            reject(error);
            return;
          }
          reject(this.failure(args, exitCode, String(stderr ?? '')));
        });
      } catch (error) {
        reject(error);
        return;
      }
      child.stdin?.on('error', () => { /* child exited before reading input */ });
      if (input !== undefined) child.stdin?.end(input);
      else child.stdin?.end();
    });
  }

  /**
   * Never report stdout as the failure: a step that already printed its result
   * (a mktemp path) and then lost the exec channel used to surface as a bare
   * path with the exit code dropped.
   */
  private failure(args: string[], exitCode: number, rawStderr: string): Error {
    const stderr = this.options.redact(rawStderr);
    const summary = `Guest command ${ GuestCommandRunner.label(args) } exited ${ exitCode }`;
    const message = stderr ? `${ summary }: ${ stderr }` : `${ summary } with no stderr`;
    const failure = GuestDiskFullError.fromGuestFailure(stderr, message);
    if (failure instanceof GuestDiskFullError) return failure;
    return new GuestCommandError(message, exitCode, stderr);
  }
}
