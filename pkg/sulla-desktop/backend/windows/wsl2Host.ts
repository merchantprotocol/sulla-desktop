// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { spawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

/** Minimal WSL process surface. Tests inject this so no host WSL state is touched. */
export interface WslCommandResult {
  stdout: Buffer | string;
  stderr?: Buffer | string;
}

export type WslCommandRunner = (args: string[], signal?: AbortSignal) => Promise<WslCommandResult>;

export interface WslProcessSpawner {
  spawn(executable: string, args: string[], options: SpawnOptions): ChildProcess;
}

export interface WslDistribution {
  name: string;
  state: 'running' | 'stopped';
  version: 1 | 2;
  isDefault: boolean;
}

export interface WslHostInspection {
  /** True means wsl.exe exists and can list distros, not that WSL2 is installed/enabled. */
  cliAvailable: boolean;
  distributions: WslDistribution[];
  /** True only when at least one registered distro is configured as WSL2 (running or stopped). */
  hasWsl2Distro: boolean;
  error?: string;
}

/**
 * Validates the WSL `--user` argument. Accepts a Linux login name or a
 * non-root numeric UID (1..2147483647, no leading zeros). Root is only ever
 * reachable through the literal name `root`, which callers use for explicit
 * administrative actions; numeric 0 is refused so a UID cannot smuggle root.
 */
export class WslUserValidator {
  private static readonly NAME = /^[a-z_][a-z0-9_-]*[$]?$/;
  private static readonly UID = /^[1-9][0-9]{0,9}$/;

  isValid(user: string): boolean {
    if (WslUserValidator.NAME.test(user)) return true;

    return WslUserValidator.UID.test(user) && Number(user) <= 2_147_483_647;
  }

  assertValid(user: string): void {
    if (!this.isValid(user)) throw new Error('Invalid WSL user');
  }
}

export const SULLA_WSL_DISTRIBUTION = 'Sulla Desktop';

/** Decode WSL's list output, which has shipped as either UTF-8 or UTF-16LE. */
export function decodeWslOutput(output: Buffer | string): string {
  if (typeof output === 'string') return output.replaceAll('\0', '').trim();

  const hasWideNuls = output.some((byte, index) => byte === 0 && index % 2 === 1);
  const decoded = hasWideNuls ? output.toString('utf16le') : output.toString('utf8');

  return decoded.replaceAll('\0', '').replaceAll('\r', '').trim();
}

/** Parse `wsl.exe --list --verbose`; ignores its localized column-heading row. */
export function parseWslDistributionList(output: Buffer | string): WslDistribution[] {
  return decodeWslOutput(output).split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\*)?\s*(.+?)\s+(Running|Stopped)\s+([12])\s*$/i);

    if (!match) return [];

    return [{
      name:      match[2].trim(),
      state:     match[3].toLowerCase() as WslDistribution['state'],
      version:   Number(match[4]) as WslDistribution['version'],
      isDefault: !!match[1],
    }];
  });
}

/**
 * Safe, narrow Windows host interface for an app-owned WSL2 distribution.
 * It never installs Windows features, enables virtualization, elevates, or
 * unregisters a distro. A caller must request those system changes explicitly.
 */
export class Wsl2Host {
  private readonly run: WslCommandRunner;
  private readonly verifyAsset: (file: string, expectedSha256: string) => Promise<void>;
  private readonly distributionName: string;
  private readonly processSpawner: WslProcessSpawner;
  private readonly userValidator = new WslUserValidator();

  constructor(
    run: WslCommandRunner = runWslCommand,
    verifyAsset: (file: string, expectedSha256: string) => Promise<void> = verifyFileSha256,
    distributionName = SULLA_WSL_DISTRIBUTION,
    processSpawner: WslProcessSpawner = { spawn },
  ) {
    this.run = run;
    this.verifyAsset = verifyAsset;
    this.distributionName = distributionName;
    this.processSpawner = processSpawner;
  }

  async inspect(): Promise<WslHostInspection> {
    try {
      const result = await this.run(['--list', '--verbose']);
      const distributions = parseWslDistributionList(result.stdout);

      return { cliAvailable: true, distributions, hasWsl2Distro: distributions.some(distro => distro.version === 2) };
    } catch (error) {
      return { cliAvailable: false, distributions: [], hasWsl2Distro: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Import a verified app-owned rootfs as an unprivileged, named WSL2 distro.
   * This is deliberately idempotence-safe: an existing distro is never
   * replaced, and no arbitrary script or shell string is evaluated.
   */
  async importDistribution(installDirectory: string, rootfsTar: string, rootfsSha256: string): Promise<void> {
    if (!path.win32.isAbsolute(installDirectory) || !path.win32.isAbsolute(rootfsTar)) {
      throw new Error('WSL install directory and rootfs asset must be absolute Windows paths');
    }
    if (!/^[a-f0-9]{64}$/i.test(rootfsSha256)) throw new Error('Invalid WSL rootfs SHA-256');

    const { cliAvailable, distributions, error } = await this.inspect();

    if (!cliAvailable) throw new Error(`Windows Subsystem for Linux is unavailable: ${ error ?? 'wsl.exe failed' }`);
    if (distributions.some(distro => distro.name.toLowerCase() === this.distributionName.toLowerCase())) {
      throw new Error(`Refusing to replace existing WSL distribution "${ this.distributionName }"`);
    }
    await this.verifyAsset(rootfsTar, rootfsSha256.toLowerCase());
    await this.run(['--import', this.distributionName, installDirectory, rootfsTar, '--version', '2']);
  }

  /** Spawn an argument-safe command in the app-owned distro; caller owns its lifecycle. */
  async runInDistribution(command: string, args: string[], user = 'root', signal?: AbortSignal): Promise<WslCommandResult> {
    if (!command.trim() || /[\r\n\0]/.test(command)) {
      throw new Error('Invalid WSL command');
    }
    this.userValidator.assertValid(user);

    return this.run(['--distribution', this.distributionName, '--user', user, '--exec', command, ...args], signal);
  }

  /** Spawn an argument-safe long-running guest command for runtime lifecycle ownership. */
  spawnInDistribution(command: string, args: string[], options: SpawnOptions = {}, user = 'root'): ChildProcess {
    if (!command.trim() || /[\r\n\0]/.test(command)) throw new Error('Invalid WSL command');
    this.userValidator.assertValid(user);

    return this.processSpawner.spawn(wslExecutablePath(), [
      '--distribution', this.distributionName, '--user', user, '--exec', command, ...args,
    ], { ...options, windowsHide: true });
  }

  /** Stop only the named app-owned distro. Does not run `wsl --shutdown`. */
  async terminateDistribution(): Promise<void> {
    await this.run(['--terminate', this.distributionName]);
  }
}

function runWslCommand(args: string[], signal?: AbortSignal): Promise<WslCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(wslExecutablePath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };

      if (code === 0) resolve(result);
      else reject(new Error(`wsl.exe exited with code ${ code }: ${ decodeWslOutput(result.stderr) }`));
    });
  });
}

function wslExecutablePath(): string {
  const windowsRoot = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows';

  return path.win32.join(windowsRoot, 'System32', 'wsl.exe');
}

export function verifyFileSha256(file: string, expectedSha256: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(file);

    input.on('data', chunk => hash.update(chunk));
    input.once('error', reject);
    input.once('end', () => {
      const actual = hash.digest('hex');

      if (actual !== expectedSha256) reject(new Error('Bundled WSL rootfs SHA-256 does not match its package manifest'));
      else resolve();
    });
  });
}
