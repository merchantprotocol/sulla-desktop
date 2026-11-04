// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as childProcess from 'node:child_process';
import { InfrastructureFailure } from '../languagemodels/providerRecovery';
import type { ContainerRuntimeDriver, ContainerSpec } from '@pkg/runtime/containerRuntime';
import paths from '@pkg/utils/paths';

export interface GuestDockerCommandExecutor {
  execute(args: string[]): Promise<{ stdout: string; stderr: string }>;
}

class GuestDockerExecError extends InfrastructureFailure {
  constructor(message: string, readonly stderr: string) {
    super(message);
    this.name = 'GuestDockerExecError';
  }
}

export class SullaRuntimeDockerCommandExecutor implements GuestDockerCommandExecutor {
  execute(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = childProcess.spawn(paths.sullaRuntime, ['exec', '--', ...args], {
        env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', chunk => { stdout += String(chunk) });
      proc.stderr.on('data', chunk => { stderr += String(chunk) });
      proc.once('error', error => reject(new GuestDockerExecError(`sulla-runtime Docker command failed to start: ${ error.message }`, '')));
      proc.once('close', code => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new GuestDockerExecError(`sulla-runtime Docker command exited ${ code }: ${ stderr.trim() || 'no stderr' }`, stderr.trim()));
      });
    });
  }
}

/** Docker runtime adapter for Electron, whose Docker daemon lives in the Sulla VM. */
export class GuestDockerRuntimeDriver implements ContainerRuntimeDriver {
  constructor(private readonly executor: GuestDockerCommandExecutor = new SullaRuntimeDockerCommandExecutor()) {}

  async create(spec: ContainerSpec): Promise<string> {
    const args = ['docker', 'create'];
    if (spec.autoRemove) args.push('--rm');
    if (spec.stdinOpen) args.push('--interactive');
    args.push('--name', spec.name);
    for (const [key, value] of Object.entries(spec.labels ?? {})) args.push('--label', `${ key }=${ value }`);
    for (const host of spec.extraHosts ?? []) args.push('--add-host', host);
    if (spec.memoryLimit) args.push('--memory', spec.memoryLimit);
    if (spec.cpuLimit) args.push('--cpus', spec.cpuLimit);
    if (spec.oomScoreAdj !== undefined) args.push('--oom-score-adj', String(spec.oomScoreAdj));
    if (spec.envFile) args.push('--env-file', spec.envFile);
    for (const [key, value] of Object.entries(spec.env ?? {})) args.push('--env', `${ key }=${ value }`);
    for (const bind of spec.binds ?? []) args.push('--volume', bind);
    for (const [target, options] of Object.entries(spec.tmpfs ?? {})) args.push('--tmpfs', `${ target }:${ options }`);
    if (spec.network) args.push('--network', spec.network);
    if (spec.workingDir) args.push('--workdir', spec.workingDir);
    if (spec.user) args.push('--user', spec.user);
    args.push(spec.image, ...(spec.command ?? []));
    return (await this.executor.execute(args)).stdout.trim();
  }

  async start(id: string): Promise<void> { await this.executor.execute(['docker', 'start', id]) }
  async stop(id: string): Promise<void> { await this.executor.execute(['docker', 'stop', '--time', '5', id]) }
  async rename(id: string, name: string): Promise<void> { await this.executor.execute(['docker', 'rename', id, name]) }
  async logs(id: string, tail = 200): Promise<string> {
    const result = await this.executor.execute(['sh', '-c', 'docker logs --tail "$1" "$2" 2>&1', 'sulla-docker-logs', String(tail), id]);
    const merged = result.stderr
      ? `${ result.stdout }${ result.stdout && !result.stdout.endsWith('\n') ? '\n' : '' }[stderr]\n${ result.stderr }`
      : result.stdout;
    return merged.split(/\r?\n/).slice(-tail - (merged.endsWith('\n') ? 1 : 0)).join('\n');
  }
  async inspect(id: string): Promise<any> { return JSON.parse((await this.executor.execute(['docker', 'inspect', id])).stdout)[0] }
  async remove(id: string, force = true): Promise<void> {
    await this.executor.execute(['docker', 'rm', ...(force ? ['--force'] : []), id]).catch(error => {
      if (!String(error).includes('No such container')) throw error;
    });
  }
  async list(label?: string): Promise<any[]> {
    const args = ['docker', 'ps', '--all', '--format', '{{json .}}'];
    if (label) args.push('--filter', `label=${ label }`);
    const output = (await this.executor.execute(args)).stdout.trim();
    return output ? output.split('\n').map(line => JSON.parse(line)) : [];
  }
}
