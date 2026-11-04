// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';

export interface WorkspaceDirEntryStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mtimeMs: number;
  size:    number;
}

/** Filesystem boundary the inspector and policy read through; never follows symlinks itself. */
export interface WorkspaceFileSystem {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<WorkspaceDirEntryStat>;
}

export class NodeWorkspaceFileSystem implements WorkspaceFileSystem {
  async readdir(path: string): Promise<string[]> {
    return await fs.readdir(path);
  }

  async lstat(path: string): Promise<WorkspaceDirEntryStat> {
    return await fs.lstat(path);
  }
}

export interface GitCommandResult {
  stdout:   string;
  exitCode: number;
}

/** Runs one git subcommand against a working directory; never throws on a non-zero exit. */
export interface GitCommandRunner {
  run(cwd: string, args: string[]): Promise<GitCommandResult>;
}

export class SpawnGitCommandRunner implements GitCommandRunner {
  run(cwd: string, args: string[]): Promise<GitCommandResult> {
    return new Promise(resolve => {
      childProcess.execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        const exitCode = (error as NodeJS.ErrnoException & { code?: unknown })?.code;
        resolve({ stdout: String(stdout ?? ''), exitCode: typeof exitCode === 'number' ? exitCode : (error ? 1 : 0) });
      });
    });
  }
}

export interface WorkspaceInspection {
  status:            'clean' | 'unsafe';
  reasons:           string[];
  hasGitRepository:  boolean;
}

/**
 * Classifies a workspace directory as clean (safe to delete: no unpublished
 * content) or unsafe. A git repository anywhere in the tree with uncommitted
 * changes, untracked non-ignored files, stash entries, commits unreachable
 * from every remote-tracking ref, or a checked-out branch with no matching
 * remote-tracking ref makes the whole workspace unsafe forever; the caller
 * must never let age or disk pressure override that verdict. Any inspection
 * failure is also unsafe (fail closed).
 */
export class WorkspaceInspector {
  constructor(
    private readonly fileSystem: WorkspaceFileSystem,
    private readonly git:        GitCommandRunner,
    private readonly maxDepth = 6,
  ) {}

  async inspect(workspacePath: string): Promise<WorkspaceInspection> {
    try {
      const repoRoots = await this.findGitRepoRoots(workspacePath, 0);
      const reasons: string[] = [];
      for (const repoRoot of repoRoots) reasons.push(...await this.inspectRepo(repoRoot));
      return { status: reasons.length ? 'unsafe' : 'clean', reasons, hasGitRepository: repoRoots.length > 0 };
    } catch (error) {
      return { status: 'unsafe', reasons: [`inspection failed: ${ this.describe(error) }`], hasGitRepository: true };
    }
  }

  private async findGitRepoRoots(directory: string, depth: number): Promise<string[]> {
    if (depth > this.maxDepth) return [];
    let names: string[];
    try { names = await this.fileSystem.readdir(directory) } catch { return [] }
    if (names.includes('.git')) return [directory];
    const roots: string[] = [];
    for (const name of names) {
      if (name === 'node_modules' || name === '.git') continue;
      const child = `${ directory }/${ name }`;
      let stat: WorkspaceDirEntryStat;
      try { stat = await this.fileSystem.lstat(child) } catch { continue }
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      roots.push(...await this.findGitRepoRoots(child, depth + 1));
    }
    return roots;
  }

  private async inspectRepo(repoRoot: string): Promise<string[]> {
    const reasons: string[] = [];
    const status = await this.git.run(repoRoot, ['status', '--porcelain=v1', '--untracked-files=normal']);
    if (status.exitCode !== 0) return [`git status failed in ${ repoRoot }`];
    if (status.stdout.trim()) reasons.push(`uncommitted or untracked changes in ${ repoRoot }`);

    const stash = await this.git.run(repoRoot, ['stash', 'list']);
    if (stash.exitCode === 0 && stash.stdout.trim()) reasons.push(`stash entries in ${ repoRoot }`);

    const unreachable = await this.git.run(repoRoot, ['log', '--branches', '--not', '--remotes', '--oneline']);
    if (unreachable.exitCode === 0 && unreachable.stdout.trim()) {
      reasons.push(`commits not reachable from any remote-tracking ref in ${ repoRoot }`);
    }

    const branch = await this.git.run(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branchName = branch.exitCode === 0 ? branch.stdout.trim() : '';
    if (branchName && branchName !== 'HEAD') {
      const remoteRefs = await this.git.run(repoRoot, ['for-each-ref', `refs/remotes/*/${ branchName }`, '--format=%(refname)']);
      if (remoteRefs.exitCode !== 0 || !remoteRefs.stdout.trim()) {
        reasons.push(`branch ${ branchName } has no remote-tracking ref in ${ repoRoot }`);
      }
    }
    return reasons;
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
