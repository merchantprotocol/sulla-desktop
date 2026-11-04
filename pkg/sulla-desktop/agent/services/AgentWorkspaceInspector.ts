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
  rename(from: string, to: string): Promise<void>;
}

export class NodeWorkspaceFileSystem implements WorkspaceFileSystem {
  async readdir(path: string): Promise<string[]> {
    return await fs.readdir(path);
  }

  async lstat(path: string): Promise<WorkspaceDirEntryStat> {
    return await fs.lstat(path);
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
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
  constructor(private readonly timeoutMs = 5_000) {}

  run(cwd: string, args: string[]): Promise<GitCommandResult> {
    return new Promise(resolve => {
      childProcess.execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: this.timeoutMs }, (error, stdout) => {
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
 * The only ignored directories that may be discarded without inspection.
 * Each is generated from source: dependency installs (node_modules), compiler
 * output (dist), Vite caches (.vite), test coverage, and tool caches (.cache).
 * Secrets, databases, exports, and arbitrary ignored files are never allowed.
 */
export class RegenerableIgnoredPathPolicy {
  private static readonly DIRECTORY_NAMES = Object.freeze(['node_modules', 'dist', 'build', '.cache', 'coverage']);

  isAllowed(gitStatusPath: string): boolean {
    const normalized = gitStatusPath.replace(/\\/g, '/').replace(/\/$/, '');
    const segments = normalized.split('/');
    return segments.some(segment => RegenerableIgnoredPathPolicy.DIRECTORY_NAMES.includes(segment))
      || (segments.at(-1)?.endsWith('.log') ?? false);
  }
}

export interface RemoteCustodyVerifier {
  verify(repoRoot: string): Promise<string[]>;
}

/** Proves custody from refs that exist on the live origin, never cached refs/remotes. */
export class LiveRemoteCustodyVerifier implements RemoteCustodyVerifier {
  constructor(private readonly git: GitCommandRunner) {}

  async verify(repoRoot: string): Promise<string[]> {
    const refs = await this.git.run(repoRoot, ['ls-remote', '--heads', '--tags', 'origin']);
    if (refs.exitCode !== 0) return [`git ls-remote failed in ${ repoRoot }`];
    const remoteTips = refs.stdout.split('\n').map(line => line.trim().split(/\s+/)[0]).filter(Boolean);
    if (!remoteTips.length) return [`live remote origin has no refs in ${ repoRoot }`];

    const unpublished = await this.git.run(repoRoot, ['rev-list', 'HEAD', '--branches', '--not', ...remoteTips]);
    if (unpublished.exitCode !== 0) return [`git rev-list against live remote failed in ${ repoRoot }`];
    return unpublished.stdout.trim() ? [`commits not reachable from any live remote ref in ${ repoRoot }`] : [];
  }
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
    private readonly ignoredPaths = new RegenerableIgnoredPathPolicy(),
    private readonly remoteCustody: RemoteCustodyVerifier = new LiveRemoteCustodyVerifier(git),
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
    if (depth > this.maxDepth) {
      throw new Error(`workspace nesting exceeds max depth ${ this.maxDepth } at ${ directory }`);
    }
    const names = await this.fileSystem.readdir(directory);
    const roots: string[] = names.includes('.git') ? [directory] : [];
    for (const name of names) {
      if (name === 'node_modules' || name === '.git') continue;
      const child = `${ directory }/${ name }`;
      const stat = await this.fileSystem.lstat(child);
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

    const ignored = await this.git.run(repoRoot, ['status', '--porcelain=v1', '--ignored', '--untracked-files=normal']);
    if (ignored.exitCode !== 0) {
      reasons.push(`git status --ignored failed in ${ repoRoot }`);
    } else {
      const unsafeIgnored = ignored.stdout.split('\n')
        .filter(line => line.startsWith('!! '))
        .map(line => line.slice(3).trim())
        .filter(entry => !this.ignoredPaths.isAllowed(entry));
      if (unsafeIgnored.length) reasons.push(`ignored non-regenerable files in ${ repoRoot }: ${ unsafeIgnored.join(', ') }`);
    }

    const stash = await this.git.run(repoRoot, ['stash', 'list']);
    if (stash.exitCode !== 0) reasons.push(`git stash list failed in ${ repoRoot }`);
    else if (stash.stdout.trim()) reasons.push(`stash entries in ${ repoRoot }`);

    reasons.push(...await this.remoteCustody.verify(repoRoot));

    const branch = await this.git.run(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branchName = branch.exitCode === 0 ? branch.stdout.trim() : '';
    if (branchName && branchName !== 'HEAD') {
      const remoteRefs = await this.git.run(repoRoot, ['ls-remote', '--heads', 'origin', `refs/heads/${ branchName }`]);
      if (remoteRefs.exitCode !== 0) {
        reasons.push(`git ls-remote for branch failed in ${ repoRoot }`);
      } else if (!remoteRefs.stdout.trim()) {
        reasons.push(`branch ${ branchName } has no live remote ref in ${ repoRoot }`);
      }
    }
    return reasons;
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
