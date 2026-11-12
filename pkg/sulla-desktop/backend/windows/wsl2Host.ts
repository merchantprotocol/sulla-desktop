// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

/** Minimal WSL process surface. Tests inject this so no host WSL state is touched. */
export interface WslCommandResult {
  stdout: Buffer | string;
  stderr?: Buffer | string;
}

export type WslCommandRunner = (args: string[]) => Promise<WslCommandResult>;

export interface WslDistribution {
  name: string;
  state: 'running' | 'stopped';
  version: 1 | 2;
  isDefault: boolean;
}

export interface WslHostInspection {
  available: boolean;
  distributions: WslDistribution[];
  error?: string;
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

  constructor(
    run: WslCommandRunner = runWslCommand,
    verifyAsset: (file: string, expectedSha256: string) => Promise<void> = verifyFileSha256,
    distributionName = SULLA_WSL_DISTRIBUTION,
  ) {
    this.run = run;
    this.verifyAsset = verifyAsset;
    this.distributionName = distributionName;
  }

  async inspect(): Promise<WslHostInspection> {
    try {
      const result = await this.run(['--list', '--verbose']);
      const distributions = parseWslDistributionList(result.stdout);

      return { available: true, distributions };
    } catch (error) {
      return { available: false, distributions: [], error: error instanceof Error ? error.message : String(error) };
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

    const { available, distributions, error } = await this.inspect();

    if (!available) throw new Error(`Windows Subsystem for Linux is unavailable: ${ error ?? 'wsl.exe failed' }`);
    if (distributions.some(distro => distro.name.toLowerCase() === this.distributionName.toLowerCase())) {
      throw new Error(`Refusing to replace existing WSL distribution "${ this.distributionName }"`);
    }
    await this.verifyAsset(rootfsTar, rootfsSha256.toLowerCase());
    await this.run(['--import', this.distributionName, installDirectory, rootfsTar, '--version', '2']);
  }

  /** Spawn an argument-safe command in the app-owned distro; caller owns its lifecycle. */
  runInDistribution(command: string, args: string[]): Promise<WslCommandResult> {
    if (!command.trim() || /[\r\n\0]/.test(command)) {
      throw new Error('Invalid WSL command');
    }

    return this.run(['--distribution', this.distributionName, '--user', 'root', '--exec', command, ...args]);
  }

  /** Stop only the named app-owned distro. Does not run `wsl --shutdown`. */
  async terminateDistribution(): Promise<void> {
    await this.run(['--terminate', this.distributionName]);
  }
}

function runWslCommand(args: string[]): Promise<WslCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
