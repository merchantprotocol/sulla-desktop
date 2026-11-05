// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as path from 'node:path';
import type { GitCommandResult, GitCommandRunner, WorkspaceDirEntryStat, WorkspaceFileSystem } from './AgentWorkspaceInspector';
import type { WorkspaceRecoveryPreserver, WorkspaceRemover } from './AgentWorkspaceRetentionPolicy';
import { GUEST_AGENT_WORKSPACES_ROOT, GUEST_RUNTIME_ROOT, runGuest } from './GuestRuntimeTransport';

export interface WorkspaceRuntimeDriver extends WorkspaceFileSystem, GitCommandRunner, WorkspaceRemover, WorkspaceRecoveryPreserver {}

export interface GuestWorkspaceCommandTransport { run(args: string[]): Promise<string>; }
export class GuestRuntimeCommandTransport implements GuestWorkspaceCommandTransport {
  async run(args: string[]): Promise<string> { return await runGuest(args); }
}

/** Every operation is executed inside the guest; no host filesystem path is opened. */
export class GuestWorkspaceRuntimeDriver implements WorkspaceRuntimeDriver {
  static readonly RECOVERY_ROOT = `${GUEST_RUNTIME_ROOT}/workspace-recovery`;
  constructor(private readonly transport: GuestWorkspaceCommandTransport = new GuestRuntimeCommandTransport(), private readonly maxRecoveryArchives = 20) {}

  async readdir(target: string): Promise<string[]> {
    const output = await this.transport.run(['find', this.bounded(target), '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\n']);
    return output ? output.split('\n').filter(Boolean) : [];
  }
  async lstat(target: string): Promise<WorkspaceDirEntryStat> {
    const output = await this.transport.run(['stat', '-c', '%F\t%Y\t%s', '--', this.bounded(target)]);
    const [kind, seconds, size] = output.trim().split('\t');
    return { isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'symbolic link', mtimeMs: Number(seconds) * 1_000, size: Number(size) };
  }
  async rename(from: string, to: string): Promise<void> { await this.transport.run(['mv', '--', this.bounded(from), this.bounded(to)]); }
  async run(cwd: string, args: string[]): Promise<GitCommandResult> {
    try { return { stdout: await this.transport.run(['git', '-C', this.bounded(cwd), ...args]), exitCode: 0 }; }
    catch { return { stdout: '', exitCode: 1 }; }
  }
  async remove(target: string): Promise<number | undefined> {
    const bounded = this.bounded(target);
    const bytes = Number(await this.transport.run(['du', '-sb', '--', bounded]).then(value => value.split(/\s+/)[0]));
    await this.transport.run(['rm', '-rf', '--', bounded]);
    return Number.isFinite(bytes) ? bytes : undefined;
  }
  async preserve(target: string, jobId: string): Promise<string> {
    const bounded = this.bounded(target);
    if (!/^agent-job-\d+-\d+$/.test(jobId)) throw new Error('invalid recovery job id');
    const archive = `${GuestWorkspaceRuntimeDriver.RECOVERY_ROOT}/${jobId}-${Date.now()}.tar.gz`;
    await this.transport.run(['sh', '-c', [
      'set -eu', 'umask 077', 'mkdir -p "$1"',
      'count=$(find "$1" -maxdepth 1 -type f -name "*.tar.gz" | wc -l)',
      '[ "$count" -lt "$4" ] || { echo "recovery archive limit reached" >&2; exit 75; }',
      'tar -C "$(dirname "$2")" -czf "$3" --exclude=node_modules --exclude=dist --exclude=build --exclude=.cache --exclude=coverage -- "$(basename "$2")"',
    ].join('; '), 'sulla-workspace-recovery', GuestWorkspaceRuntimeDriver.RECOVERY_ROOT, bounded, archive, String(this.maxRecoveryArchives)]);
    return archive;
  }
  private bounded(candidate: string): string {
    const resolved = path.posix.resolve(candidate);
    if (resolved !== GUEST_AGENT_WORKSPACES_ROOT && !resolved.startsWith(`${GUEST_AGENT_WORKSPACES_ROOT}/`)) throw new Error(`workspace path escaped guest root: ${candidate}`);
    return resolved;
  }
}
