// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ChildProcess, SpawnOptions } from 'child_process';

import { decodeWslOutput } from './wsl2Host';
import type { WslCommandResult } from './wsl2Host';

/** WSL2 boundary consumed by the Windows runtime adapter. */
export interface Wsl2RuntimeHost {
  runInDistribution(command: string, args: string[], user?: string, signal?: AbortSignal): Promise<WslCommandResult>;
  spawnInDistribution(command: string, args: string[], options?: SpawnOptions, user?: string): ChildProcess;
  terminateDistribution(): Promise<void>;
}

export interface Wsl2DockerRuntimeOptions {
  /** Rootless Docker daemon launcher installed in the app-owned distro. */
  daemonCommand: string;
  daemonArgs?: string[];
  /** A command that exits zero only after the daemon accepts API requests. */
  readinessCommand: string;
  readinessArgs: string[];
  /** Explicit rootless runtime environment; WSL --exec does not source a shell profile. */
  environment: Record<string, string>;
  user: string;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  stopTimeoutMs?: number;
}

export type RuntimeSleep = (milliseconds: number) => Promise<void>;

class Wsl2ReadinessTimeout extends Error {}

/**
 * Starts rootless Docker inside only Sulla's WSL2 distro and exposes its
 * execution boundary. Readiness is confirmed by the Docker client rather
 * than by process presence; startup failures always terminate this distro.
 */
export class Wsl2DockerRuntime {
  private child?: ChildProcess;
  private started = false;

  constructor(
    private readonly host: Wsl2RuntimeHost,
    private readonly options: Wsl2DockerRuntimeOptions,
    private readonly sleep: RuntimeSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  ) {}

  private withEnvironment(command: string, args: string[]): [string, string[]] {
    const assignments = Object.entries(this.options.environment).map(([name, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || /[\0\r\n]/.test(value)) throw new Error(`Invalid WSL runtime environment entry: ${ name }`);

      return `${ name }=${ value }`;
    });

    return ['/usr/bin/env', [...assignments, '--', command, ...args]];
  }

  private runProbe(command: string, args: string[], timeoutMs: number, description: string): Promise<WslCommandResult> {
    const controller = new AbortController();
    const [environmentCommand, environmentArgs] = this.withEnvironment(command, args);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Wsl2ReadinessTimeout(`${ description } timed out after ${ timeoutMs }ms`));
      }, timeoutMs);
      let probe: Promise<WslCommandResult>;

      try {
        probe = this.host.runInDistribution(environmentCommand, environmentArgs, this.options.user, controller.signal);
      } catch (error) {
        clearTimeout(timer);
        reject(error);

        return;
      }

      probe.then((result) => {
        clearTimeout(timer);
        resolve(result);
      }, (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  get running(): boolean {
    return this.started && !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.child) await this.stop();

    const readyBy = Date.now() + (this.options.readyTimeoutMs ?? 60_000);
    const userProbeTime = readyBy - Date.now();
    if (userProbeTime <= 0) throw new Wsl2ReadinessTimeout('WSL runtime user check timed out before it started');
    const userResult = await this.runProbe('/usr/bin/id', ['-u'], userProbeTime, 'WSL runtime user check');
    const userId = decodeWslOutput(userResult.stdout).trim();

    if (!/^[1-9][0-9]*$/.test(userId) || !Number.isSafeInteger(Number(userId))) {
      throw new Error('Configured WSL2 runtime user must exist and have a non-root numeric UID');
    }

    const [daemonCommand, daemonArgs] = this.withEnvironment(this.options.daemonCommand, this.options.daemonArgs ?? []);
    const child = this.host.spawnInDistribution(daemonCommand, daemonArgs, { windowsHide: true }, this.options.user);
    this.child = child;
    const pollMs = this.options.pollIntervalMs ?? 500;
    let processError: Error | undefined;

    child.once('error', error => { processError = error; });

    try {
      while (Date.now() < readyBy) {
        if (processError) throw new Error(`Could not start rootless Docker: ${ processError.message }`);
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Rootless Docker exited before becoming ready (${ child.signalCode ?? `code ${ child.exitCode }` })`);
        }
        try {
          await this.runProbe(this.options.readinessCommand, this.options.readinessArgs, readyBy - Date.now(), 'Rootless Docker readiness probe');
        } catch (error) {
          if (error instanceof Wsl2ReadinessTimeout) throw error;
          await this.sleep(Math.min(pollMs, Math.max(0, readyBy - Date.now())));
          continue;
        }
        if (processError) throw new Error(`Could not start rootless Docker: ${ processError.message }`);
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Rootless Docker exited while the readiness probe completed (${ child.signalCode ?? `code ${ child.exitCode }` })`);
        }
        this.started = true;

        return;
      }
      throw new Wsl2ReadinessTimeout(`Rootless Docker did not become ready within ${ this.options.readyTimeoutMs ?? 60_000 }ms`);
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async run(command: string, args: string[]): Promise<WslCommandResult> {
    if (!this.running) throw new Error('The WSL2 Docker runtime is not running');
    const [environmentCommand, environmentArgs] = this.withEnvironment(command, args);

    return this.host.runInDistribution(environmentCommand, environmentArgs, this.options.user);
  }

  async stop(): Promise<void> {
    const child = this.child;

    this.started = false;
    if (child && child.exitCode === null && child.signalCode === null) {
      const timeoutMs = this.options.stopTimeoutMs ?? 10_000;
      await new Promise<void>(resolve => {
        const onExit = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          child.removeListener('exit', onExit);
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          resolve();
        }, timeoutMs);
        child.once('exit', onExit);
        child.kill('SIGTERM');
      });
    }
    this.child = undefined;
    await this.host.terminateDistribution();
  }
}
