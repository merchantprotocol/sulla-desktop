// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { spawn as nodeSpawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import type { execOptions, VMExecutor } from '@pkg/backend/backend';

export interface DockerCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Seam over the host `docker` binary so the executor can be tested without an engine. */
export interface DockerCli {
  run(args: string[], options?: { input?: string; env?: NodeJS.ProcessEnv }): Promise<DockerCliResult>;
  spawn(args: string[], options?: { env?: NodeJS.ProcessEnv }): ChildProcess;
}

export class NodeDockerCli implements DockerCli {
  run(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<DockerCliResult> {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn('docker', args, { env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.stdin.on('error', () => { /* the exit code reports the failure */ });
      child.on('error', () => reject(new Error('The Docker CLI could not be started.')));
      child.on('close', (code, signal) => resolve({
        stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(err).toString('utf-8'), exitCode: code ?? (signal ? 128 : 1),
      }));
      child.stdin.end(options.input);
    });
  }

  spawn(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): ChildProcess {
    return nodeSpawn('docker', args, { env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  }
}

/**
 * Runs commands inside the app-owned runtime container with `docker exec`.
 * It never runs anything on the host except the `docker` client, and it only
 * addresses the one container it was constructed with.
 */
export class LinuxContainerExecutor implements VMExecutor {
  readonly backend = 'linux-docker' as const;

  constructor(private readonly cli: DockerCli, private readonly container: string) {
    if (!/^sulla-desktop-[a-z0-9_-]+$/.test(container)) throw new Error('Runtime container name must use the sulla-desktop- prefix.');
  }

  private execArgs(options: execOptions, command: string[], interactive: boolean): { args: string[]; env: NodeJS.ProcessEnv } {
    if (command.length === 0 || command.some(part => part.includes('\0'))) throw new Error('A command is required.');
    const args = ['exec'];
    const env: NodeJS.ProcessEnv = {};

    if (interactive) args.push('-i');
    if (options.root) args.push('--user', '0:0');
    if (options.cwd) args.push('--workdir', String(options.cwd));
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value === undefined) continue;
      // Pass by name only so values never appear in the host process list.
      args.push('--env', key);
      env[key] = String(value);
    }

    return { args: [...args, this.container, ...command], env };
  }

  execCommand(...command: string[]): Promise<void>;
  execCommand(options: execOptions, ...command: string[]): Promise<void>;
  execCommand(options: execOptions & { capture: true }, ...command: string[]): Promise<string>;
  async execCommand(optionsOrArg: execOptions | string, ...command: string[]): Promise<void | string> {
    const options: execOptions & { capture?: boolean } = typeof optionsOrArg === 'string' ? {} : optionsOrArg;
    const argv = typeof optionsOrArg === 'string' ? [optionsOrArg, ...command] : command;
    const { args, env } = this.execArgs(options, argv, false);
    const result = await this.cli.run(args, { env });

    if (options.logStream) options.logStream.write(result.stdout + result.stderr);
    if (result.exitCode !== 0) {
      const error = new Error(`Command "${ argv[0] }" exited with ${ result.exitCode } in the runtime container: ${ result.stderr.trim() }`);

      Object.assign(error, { stdout: result.stdout, stderr: result.stderr, code: result.exitCode });
      throw error;
    }

    return options.capture ? result.stdout : undefined;
  }

  spawn(...command: string[]): ChildProcess;
  spawn(options: execOptions, ...command: string[]): ChildProcess;
  spawn(optionsOrCommand: execOptions | string, ...command: string[]): ChildProcess {
    const options: execOptions = typeof optionsOrCommand === 'string' ? {} : optionsOrCommand;
    const argv = typeof optionsOrCommand === 'string' ? [optionsOrCommand, ...command] : command;
    const { args, env } = this.execArgs(options, argv, true);

    return this.cli.spawn(args, { env });
  }

  async readFile(filePath: string, options?: { encoding?: BufferEncoding }): Promise<string> {
    this.assertGuestPath(filePath);
    const result = await this.cli.run(['exec', this.container, 'cat', '--', filePath]);

    if (result.exitCode !== 0) throw new Error(`Failed to read ${ filePath } in the runtime container: ${ result.stderr.trim() }`);

    return Buffer.from(result.stdout, 'utf-8').toString(options?.encoding ?? 'utf-8');
  }

  async writeFile(filePath: string, fileContents: string, permissions: fs.Mode = 0o644): Promise<void> {
    this.assertGuestPath(filePath);
    const mode = typeof permissions === 'number' ? permissions.toString(8) : String(permissions);

    if (!/^[0-7]{3,4}$/.test(mode)) throw new Error('File permissions must be an octal mode.');
    const { args } = this.execArgs({ root: true }, [
      'sh', '-c', 'cat > "$1.tmp" && chmod "$2" "$1.tmp" && mv "$1.tmp" "$1"', 'sh', filePath, mode,
    ], true);
    const result = await this.cli.run(args, { input: fileContents });

    if (result.exitCode !== 0) throw new Error(`Failed to write ${ filePath } in the runtime container: ${ result.stderr.trim() }`);
  }

  async copyFileIn(hostPath: string, vmPath: string): Promise<void> {
    this.assertGuestPath(vmPath);
    this.assertHostPath(hostPath);
    const copy = await this.cli.run(['cp', '--', hostPath, `${ this.container }:${ vmPath }`]);

    if (copy.exitCode !== 0) throw new Error(`Failed to copy ${ hostPath } into the runtime container: ${ copy.stderr.trim() }`);
    await this.execCommand({ root: true }, 'chmod', '644', vmPath);
  }

  async copyFileOut(vmPath: string, hostPath: string): Promise<void> {
    this.assertGuestPath(vmPath);
    this.assertHostPath(hostPath);
    const copy = await this.cli.run(['cp', '--', `${ this.container }:${ vmPath }`, hostPath]);

    if (copy.exitCode !== 0) throw new Error(`Failed to copy ${ vmPath } out of the runtime container: ${ copy.stderr.trim() }`);
  }

  private assertGuestPath(filePath: string): void {
    if (!path.posix.isAbsolute(filePath) || filePath.includes('\0')) throw new Error('Runtime container paths must be absolute.');
  }

  private assertHostPath(hostPath: string): void {
    if (!path.isAbsolute(hostPath) || hostPath.includes('\0')) throw new Error('Host paths must be absolute.');
  }
}
