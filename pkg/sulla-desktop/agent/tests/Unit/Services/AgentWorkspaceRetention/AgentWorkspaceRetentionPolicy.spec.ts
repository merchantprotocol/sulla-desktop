// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NodeWorkspaceFileSystem,
  SpawnGitCommandRunner,
  WorkspaceInspector,
  type GitCommandResult,
  type GitCommandRunner,
  type WorkspaceDirEntryStat,
  type WorkspaceFileSystem,
} from '../../../../services/AgentWorkspaceInspector';
import {
  AgentWorkspaceRetentionPolicy,
  type ActiveJobGuard,
  type DiskSpaceProbe,
  type RetentionClock,
  type WorkspaceRemover,
  type WorkspaceJobState,
  type WorkspaceJobStateReader,
  type WorkspaceRecoveryPreserver,
} from '../../../../services/AgentWorkspaceRetentionPolicy';
import { WorkspaceRetentionConfig } from '../../../../services/AgentWorkspaceRetentionConfig';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepoWithRemote(repoDir: string, remoteDir: string): void {
  mkdirSync(remoteDir, { recursive: true });
  git(remoteDir, ['init', '--bare', '-q']);
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'test@sulladesktop.com']);
  git(repoDir, ['config', 'user.name', 'Sulla Test']);
  git(repoDir, ['remote', 'add', 'origin', remoteDir]);
}

function commit(repoDir: string, fileName: string, content: string): void {
  writeFileSync(path.join(repoDir, fileName), content);
  git(repoDir, ['add', fileName]);
  git(repoDir, ['commit', '-q', '-m', `add ${ fileName }`]);
}

let jobCounter = 0;
function nextJobId(): string {
  jobCounter += 1;
  return `agent-job-179382${ jobCounter }-${ jobCounter }`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0').slice(0, 8);
}

function workspaceDirName(jobId: string, taskIndex = 0): string {
  return `${ jobId }-${ taskIndex }-${ randomSuffix() }`;
}

async function setMtime(targetPath: string, whenMs: number): Promise<void> {
  const when = new Date(whenMs);
  await fsPromises.utimes(targetPath, when, when);
}

class FixtureClock implements RetentionClock {
  constructor(private time: number) {}
  now(): number { return this.time }
}

class FixtureActiveJobGuard implements ActiveJobGuard {
  private readonly active = new Set<string>();
  markActive(jobId: string): void { this.active.add(jobId) }
  isActive(jobId: string): boolean { return this.active.has(jobId) }
}


class FixtureJobStateReader implements WorkspaceJobStateReader {
  private readonly states = new Map<string, WorkspaceJobState>();
  set(jobId: string, state: WorkspaceJobState): void { this.states.set(jobId, state) }
  async state(jobId: string): Promise<WorkspaceJobState | undefined> { return this.states.get(jobId) }
}
class FixtureRecoveryPreserver implements WorkspaceRecoveryPreserver {
  readonly preserved: string[] = [];
  async preserve(_path: string, jobId: string): Promise<string> { this.preserved.push(jobId); return `/recovery/${ jobId }.tar.gz`; }
}

class FixtureDiskSpaceProbe implements DiskSpaceProbe {
  constructor(private bytes: number) {}
  async freeBytes(): Promise<number> { return this.bytes }
}

/** Wraps a real WorkspaceFileSystem but fails one specific path's readdir and/or lstat, to prove the inspector fails closed. */
class SubpathFailingFileSystem implements WorkspaceFileSystem {
  constructor(
    private readonly delegate:       WorkspaceFileSystem,
    private readonly failReaddirFor?: string,
    private readonly failLstatFor?:   string,
  ) {}

  async readdir(path: string): Promise<string[]> {
    if (this.originalPath(path) === this.failReaddirFor) throw new Error(`simulated readdir failure for ${ path }`);
    return this.delegate.readdir(path);
  }

  async lstat(path: string): Promise<WorkspaceDirEntryStat> {
    if (this.originalPath(path) === this.failLstatFor) throw new Error(`simulated lstat failure for ${ path }`);
    return this.delegate.lstat(path);
  }

  async rename(from: string, to: string): Promise<void> {
    return this.delegate.rename(from, to);
  }

  private originalPath(candidate: string): string {
    return candidate.replace('/.reclaiming-', '/');
  }
}

/** Wraps a real GitCommandRunner but forces one git subcommand to fail, to prove the inspector fails closed. */
class SubcommandFailingGitCommandRunner implements GitCommandRunner {
  constructor(
    private readonly delegate:          GitCommandRunner,
    private readonly failingSubcommand: string,
  ) {}

  async run(cwd: string, args: string[]): Promise<GitCommandResult> {
    if (args[0] === this.failingSubcommand) return { stdout: '', exitCode: 1 };
    return this.delegate.run(cwd, args);
  }
}

class ActivatingGitCommandRunner implements GitCommandRunner {
  private activated = false;

  constructor(
    private readonly delegate: GitCommandRunner,
    private readonly activate: () => void,
  ) {}

  async run(cwd: string, args: string[]): Promise<GitCommandResult> {
    if (!this.activated && args[0] === 'status') {
      this.activated = true;
      this.activate();
    }
    return this.delegate.run(cwd, args);
  }
}

class FixtureWorkspaceRemover implements WorkspaceRemover {
  readonly removedPaths: string[] = [];
  private readonly failing = new Set<string>();
  private readonly freedBytesByPath = new Map<string, number>();

  failFor(targetPath: string): void { this.failing.add(targetPath) }
  freeBytesFor(targetPath: string, bytes: number): void { this.freedBytesByPath.set(targetPath, bytes) }

  async remove(targetPath: string): Promise<number | undefined> {
    const originalPath = path.join(path.dirname(targetPath), path.basename(targetPath).replace(/^\.reclaiming-/, ''));
    if (this.failing.has(originalPath)) throw new Error(`simulated delete failure for ${ originalPath }`);
    await fsPromises.rm(targetPath, { recursive: true, force: true });
    this.removedPaths.push(originalPath);
    return this.freedBytesByPath.get(originalPath);
  }
}

describe('AgentWorkspaceRetentionPolicy', () => {
  const day = 24 * 60 * 60 * 1_000;
  let root: string;
  let outsideRoot: string;
  const fileSystem = new NodeWorkspaceFileSystem();
  const inspector = new WorkspaceInspector(fileSystem, new SpawnGitCommandRunner());

  beforeEach(async() => {
    root = await fsPromises.mkdtemp(path.join(tmpdir(), 'sulla-workspace-retention-'));
    outsideRoot = await fsPromises.mkdtemp(path.join(tmpdir(), 'sulla-workspace-retention-outside-'));
  });

  afterEach(async() => {
    await fsPromises.rm(root, { recursive: true, force: true });
    await fsPromises.rm(outsideRoot, { recursive: true, force: true });
  });

  function buildPolicy(options: {
    now?:              number;
    guard?:            FixtureActiveJobGuard;
    diskFreeBytes?:    number;
    remover?:          FixtureWorkspaceRemover;
    retentionWindowMs?: number;
    minFreeDiskBytes?: number;
    inspector?:        WorkspaceInspector;
    jobs?:             WorkspaceJobStateReader;
    recovery?:         WorkspaceRecoveryPreserver;
  } = {}) {
    const clock = new FixtureClock(options.now ?? Date.now());
    const guard = options.guard ?? new FixtureActiveJobGuard();
    const diskSpaceProbe = new FixtureDiskSpaceProbe(options.diskFreeBytes ?? Number.MAX_SAFE_INTEGER);
    const remover = options.remover ?? new FixtureWorkspaceRemover();
    const config = new WorkspaceRetentionConfig({
      retentionWindowMs: options.retentionWindowMs,
      minFreeDiskBytes:  options.minFreeDiskBytes,
    });
    const policy = new AgentWorkspaceRetentionPolicy(
      root, fileSystem, options.inspector ?? inspector, guard, clock, diskSpaceProbe, remover, config, undefined, options.jobs, options.recovery,
    );
    return { policy, clock, guard, diskSpaceProbe, remover };
  }

  function pushedCleanRepo(workspacePath: string, remoteDir: string): void {
    initRepoWithRemote(workspacePath, remoteDir);
    commit(workspacePath, 'a.txt', 'one');
    git(workspacePath, ['push', '-u', 'origin', 'main']);
  }

  it('removes a truly empty non-git workspace of a terminal job immediately', async() => {
    // risk: 2,071 retained workspaces at 8.4 GB never get swept away; disk fills again
    const jobId = nextJobId();
    const dirName = workspaceDirName(jobId);
    const workspacePath = path.join(root, dirName);
    await fsPromises.mkdir(workspacePath);

    const { policy, remover } = buildPolicy();
    const report = await policy.enforce();

    expect(report.removed).toEqual([{ path: workspacePath, jobId, reason: 'clean' }]);
    expect(remover.removedPaths).toContain(workspacePath);
    await expect(fsPromises.access(workspacePath)).rejects.toThrow();
  });

  it('keeps a non-git workspace that still has files inside the retention window', async() => {
    // risk: scratch output from a job that just finished is deleted before anyone can look at it
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    await fsPromises.writeFile(path.join(workspacePath, 'notes.txt'), 'scratch output, no git');

    const { policy } = buildPolicy();
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(report.keptUnsafe).toEqual([]);
    await expect(fsPromises.access(workspacePath)).resolves.toBeUndefined();
  });

  it('removes a non-git workspace with files once it clears the retention window', async() => {
    // risk: a non-git scratch workspace with files never ages out because it is never seen as "clean"
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    await fsPromises.writeFile(path.join(workspacePath, 'notes.txt'), 'scratch output, no git');
    await setMtime(workspacePath, Date.now() - 8 * day);

    const { policy } = buildPolicy({ now: Date.now() });
    const report = await policy.enforce();

    expect(report.removed).toEqual([{ path: workspacePath, jobId, reason: 'age' }]);
  });

  it('keeps an uncommitted change forever, even past the seven-day window', async() => {
    // risk: a job's unsaved work is deleted before anyone can recover it
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    const remoteDir = path.join(outsideRoot, 'remote.git');
    initRepoWithRemote(workspacePath, remoteDir);
    commit(workspacePath, 'a.txt', 'one');
    git(workspacePath, ['push', '-u', 'origin', 'main']);
    await fsPromises.writeFile(path.join(workspacePath, 'a.txt'), 'uncommitted edit');
    await setMtime(workspacePath, Date.now() - 8 * day);

    const { policy } = buildPolicy({ now: Date.now() });
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(report.keptUnsafe).toHaveLength(1);
    expect(report.keptUnsafe[0].jobId).toBe(jobId);
    expect(report.keptUnsafe[0].reasons.join(' ')).toMatch(/uncommitted/);
    await expect(fsPromises.access(workspacePath)).resolves.toBeUndefined();
  });

  it('keeps a commit that was never pushed', async() => {
    // risk: real finished work that only exists locally is destroyed
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    const remoteDir = path.join(outsideRoot, 'remote.git');
    initRepoWithRemote(workspacePath, remoteDir);
    commit(workspacePath, 'a.txt', 'one');
    git(workspacePath, ['push', '-u', 'origin', 'main']);
    commit(workspacePath, 'b.txt', 'two');
    await setMtime(workspacePath, Date.now() - 8 * day);

    const { policy } = buildPolicy({ now: Date.now() });
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(report.keptUnsafe[0].reasons.join(' ')).toMatch(/not reachable from any live remote ref/);
  });

  it('keeps a branch with no remote-tracking ref even when its commit is otherwise safe', async() => {
    // risk: a feature branch with real intent is reclaimed just because no one pushed it
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    const remoteDir = path.join(outsideRoot, 'remote.git');
    initRepoWithRemote(workspacePath, remoteDir);
    commit(workspacePath, 'a.txt', 'one');
    git(workspacePath, ['push', '-u', 'origin', 'main']);
    git(workspacePath, ['checkout', '-q', '-b', 'feature']);
    await setMtime(workspacePath, Date.now() - 8 * day);

    const { policy } = buildPolicy({ now: Date.now() });
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(report.keptUnsafe[0].reasons.join(' ')).toMatch(/feature has no live remote ref/);
  });

  it('removes a pushed, fully clean repo once it clears the retention window', async() => {
    // risk: fully published checkouts are held onto forever, wasting disk anyway
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    const remoteDir = path.join(outsideRoot, 'remote.git');
    initRepoWithRemote(workspacePath, remoteDir);
    commit(workspacePath, 'a.txt', 'one');
    git(workspacePath, ['push', '-u', 'origin', 'main']);
    await setMtime(workspacePath, Date.now() - 30 * day);

    const { policy } = buildPolicy({ now: Date.now() });
    const report = await policy.enforce();

    expect(report.removed).toEqual([{ path: workspacePath, jobId, reason: 'age' }]);
  });

  it('skips a workspace whose job is still active, however old or risky it looks', async() => {
    // risk: deleting a running job's workspace out from under it corrupts the job
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    await fsPromises.writeFile(path.join(workspacePath, 'notes.txt'), 'scratch');
    await setMtime(workspacePath, Date.now() - 30 * day);

    const guard = new FixtureActiveJobGuard();
    guard.markActive(jobId);
    const { policy } = buildPolicy({ now: Date.now(), guard });
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(report.keptUnsafe).toEqual([]);
    await expect(fsPromises.access(workspacePath)).resolves.toBeUndefined();
  });

  it('keeps a pushed, clean repo until it clears the window, then removes it', async() => {
    // risk: the age gate fires too early (destroys recent recoverable state) or never fires (disk never recovers)
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    const remoteDir = path.join(outsideRoot, 'remote.git');
    initRepoWithRemote(workspacePath, remoteDir);
    commit(workspacePath, 'a.txt', 'one');
    git(workspacePath, ['push', '-u', 'origin', 'main']);
    await setMtime(workspacePath, Date.now() - 2 * day);

    const window = 7 * day;
    const { policy: youngPolicy } = buildPolicy({ now: Date.now(), retentionWindowMs: window });
    const youngReport = await youngPolicy.enforce();
    expect(youngReport.removed).toEqual([]);

    const { policy: oldPolicy } = buildPolicy({ now: Date.now() + 10 * day, retentionWindowMs: window });
    const oldReport = await oldPolicy.enforce();
    expect(oldReport.removed).toEqual([{ path: workspacePath, jobId, reason: 'age' }]);
  });

  it('under disk pressure, removes the oldest safe-but-young workspaces first and stops once above the floor', async() => {
    // risk: either nothing is reclaimed in an emergency, or everything is wiped at once
    const now = Date.now();
    const jobs = [
      { ageMs: 3 * day, freed: 2 * 1024 * 1024 * 1024 },
      { ageMs: 2 * day, freed: 2 * 1024 * 1024 * 1024 },
      { ageMs: 1 * day, freed: 2 * 1024 * 1024 * 1024 },
    ];
    const paths: string[] = [];
    const remover = new FixtureWorkspaceRemover();
    for (const job of jobs) {
      const jobId = nextJobId();
      const workspacePath = path.join(root, workspaceDirName(jobId));
      await fsPromises.mkdir(workspacePath);
      await setMtime(workspacePath, now - job.ageMs);
      paths.push(workspacePath);
      remover.freeBytesFor(workspacePath, job.freed);
    }
    // Make every workspace carry real git history so none qualifies for immediate 'clean' removal.
    for (const workspacePath of paths) {
      const remoteDir = `${ workspacePath }-remote.git`;
      initRepoWithRemote(workspacePath, remoteDir);
      commit(workspacePath, 'a.txt', 'one');
      git(workspacePath, ['push', '-u', 'origin', 'main']);
    }
    for (let index = 0; index < paths.length; index += 1) await setMtime(paths[index], now - jobs[index].ageMs);

    const { policy } = buildPolicy({
      now, remover, diskFreeBytes: 1 * 1024 * 1024 * 1024, minFreeDiskBytes: 5 * 1024 * 1024 * 1024,
      retentionWindowMs: 30 * day,
    });
    const report = await policy.enforce();

    expect(report.removed.map(entry => entry.path)).toEqual([paths[0], paths[1]]);
    expect(report.removed.every(entry => entry.reason === 'disk')).toBe(true);
    await expect(fsPromises.access(paths[0])).rejects.toThrow();
    await expect(fsPromises.access(paths[1])).rejects.toThrow();
    await expect(fsPromises.access(paths[2])).resolves.toBeUndefined();
  });

  it('never follows or deletes a symlink even when it looks like a workspace', async() => {
    // risk: a symlinked workspace entry lets a stale sweep reach outside its guest root
    const jobId = nextJobId();
    const dirName = workspaceDirName(jobId);
    const linkPath = path.join(root, dirName);
    const realTarget = path.join(outsideRoot, 'real-target');
    await fsPromises.mkdir(realTarget);
    await fsPromises.writeFile(path.join(realTarget, 'secret.txt'), 'must survive');
    await fsPromises.symlink(realTarget, linkPath);

    const { policy } = buildPolicy();
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(report.keptUnsafe).toEqual([]);
    await expect(fsPromises.access(path.join(realTarget, 'secret.txt'))).resolves.toBeUndefined();
  });

  it('leaves a sibling directory that does not match the workspace naming pattern untouched', async() => {
    // risk: the sweep reaches unrelated guest-runtime directories under the same root
    const siblingPath = path.join(root, 'not-a-job-workspace');
    await fsPromises.mkdir(siblingPath);
    await fsPromises.writeFile(path.join(siblingPath, 'file.txt'), 'unrelated');
    await setMtime(siblingPath, Date.now() - 30 * day);

    const { policy } = buildPolicy();
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    await expect(fsPromises.access(siblingPath)).resolves.toBeUndefined();
  });

  it('records a delete failure without stopping the rest of the run', async() => {
    // risk: one stuck guest path blocks reclaiming everything else behind it
    const jobIdA = nextJobId();
    const workspaceA = path.join(root, workspaceDirName(jobIdA));
    await fsPromises.mkdir(workspaceA);

    const jobIdB = nextJobId();
    const workspaceB = path.join(root, workspaceDirName(jobIdB));
    await fsPromises.mkdir(workspaceB);

    const remover = new FixtureWorkspaceRemover();
    remover.failFor(workspaceA);
    const { policy } = buildPolicy({ remover });
    const report = await policy.enforce();

    expect(report.errors).toEqual([{ path: workspaceA, error: `simulated delete failure for ${ workspaceA }` }]);
    expect(report.removed).toEqual([{ path: workspaceB, jobId: jobIdB, reason: 'clean' }]);
    await expect(fsPromises.access(workspaceA)).resolves.toBeUndefined();
    await expect(fsPromises.access(workspaceB)).rejects.toThrow();
  });

  it('keeps a workspace when a nested directory cannot be read', async() => {
    // risk: a readdir error deep in the tree is swallowed and a repo that was never actually inspected gets deleted
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    const brokenDir = path.join(workspacePath, 'broken');
    await fsPromises.mkdir(brokenDir);
    await setMtime(workspacePath, Date.now() - 8 * day);

    const failingFs = new SubpathFailingFileSystem(fileSystem, brokenDir);
    const failingInspector = new WorkspaceInspector(failingFs, new SpawnGitCommandRunner());
    const { policy } = buildPolicy({ now: Date.now(), inspector: failingInspector });
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(report.keptUnsafe).toHaveLength(1);
    expect(report.keptUnsafe[0].reasons.join(' ')).toMatch(/inspection failed/);
  });

  it('keeps a workspace when a nested entry cannot be lstat-ed', async() => {
    // risk: an lstat error on one entry is swallowed and the sibling that hides the real repo is skipped silently
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    const brokenEntry = path.join(workspacePath, 'broken-entry');
    await fsPromises.mkdir(brokenEntry);
    await setMtime(workspacePath, Date.now() - 8 * day);

    const failingFs = new SubpathFailingFileSystem(fileSystem, undefined, brokenEntry);
    const failingInspector = new WorkspaceInspector(failingFs, new SpawnGitCommandRunner());
    const { policy } = buildPolicy({ now: Date.now(), inspector: failingInspector });
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(report.keptUnsafe).toHaveLength(1);
    expect(report.keptUnsafe[0].reasons.join(' ')).toMatch(/inspection failed/);
  });

  it('keeps a workspace nested deeper than the inspector can fully walk', async() => {
    // risk: a repo nested past maxDepth is silently skipped and treated as if it never existed
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    const deepDir = path.join(workspacePath, 'level1', 'level2');
    await fsPromises.mkdir(deepDir, { recursive: true });
    await setMtime(workspacePath, Date.now() - 8 * day);

    const shallowInspector = new WorkspaceInspector(fileSystem, new SpawnGitCommandRunner(), 1);
    const { policy } = buildPolicy({ now: Date.now(), inspector: shallowInspector });
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(report.keptUnsafe).toHaveLength(1);
    expect(report.keptUnsafe[0].reasons.join(' ')).toMatch(/inspection failed/);
  });

  it.each(['stash', 'rev-list', 'ls-remote'])('keeps a workspace when git %s fails', async(subcommand) => {
    // risk: a transient git failure (crash, timeout) is read as "no findings" instead of "couldn't check"
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    const remoteDir = path.join(outsideRoot, 'remote.git');
    pushedCleanRepo(workspacePath, remoteDir);
    await setMtime(workspacePath, Date.now() - 8 * day);

    const failingGit = new SubcommandFailingGitCommandRunner(new SpawnGitCommandRunner(), subcommand);
    const failingInspector = new WorkspaceInspector(fileSystem, failingGit);
    const { policy } = buildPolicy({ now: Date.now(), inspector: failingInspector });
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(report.keptUnsafe).toHaveLength(1);
    const reasonText = report.keptUnsafe[0].reasons.join(' ');
    expect(reasonText).toContain(subcommand);
    expect(reasonText).toMatch(/failed/);
  });

  it('keeps a detached-HEAD commit that was never pushed or branched', async() => {
    // risk: a job that finished mid-rebase/cherry-pick in detached HEAD loses real, unpushed work
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    const remoteDir = path.join(outsideRoot, 'remote.git');
    pushedCleanRepo(workspacePath, remoteDir);
    git(workspacePath, ['checkout', '-q', '--detach', 'HEAD']);
    commit(workspacePath, 'b.txt', 'two');
    await setMtime(workspacePath, Date.now() - 8 * day);

    const { policy } = buildPolicy({ now: Date.now() });
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(report.keptUnsafe).toHaveLength(1);
    expect(report.keptUnsafe[0].reasons.join(' ')).toMatch(/not reachable from any live remote ref/);
  });

  it('keeps ignored secrets but permits ignored regenerable dependencies', async() => {
    // risk: ignored secrets or databases are silently destroyed; generated dependencies unnecessarily block reclaim
    const unsafeJobId = nextJobId();
    const unsafePath = path.join(root, workspaceDirName(unsafeJobId));
    await fsPromises.mkdir(unsafePath);
    const unsafeRemote = path.join(outsideRoot, 'ignored-unsafe.git');
    initRepoWithRemote(unsafePath, unsafeRemote);
    writeFileSync(path.join(unsafePath, '.gitignore'), '.env\nnode_modules/\n');
    git(unsafePath, ['add', '.gitignore']);
    git(unsafePath, ['commit', '-q', '-m', 'ignore generated and secret files']);
    git(unsafePath, ['push', '-u', 'origin', 'main']);
    writeFileSync(path.join(unsafePath, '.env'), 'must survive');
    await setMtime(unsafePath, Date.now() - 8 * day);

    const safeJobId = nextJobId();
    const safePath = path.join(root, workspaceDirName(safeJobId));
    await fsPromises.mkdir(safePath);
    const safeRemote = path.join(outsideRoot, 'ignored-safe.git');
    initRepoWithRemote(safePath, safeRemote);
    writeFileSync(path.join(safePath, '.gitignore'), 'node_modules/\n');
    git(safePath, ['add', '.gitignore']);
    git(safePath, ['commit', '-q', '-m', 'ignore dependencies']);
    git(safePath, ['push', '-u', 'origin', 'main']);
    await fsPromises.mkdir(path.join(safePath, 'node_modules'));
    writeFileSync(path.join(safePath, 'node_modules', 'generated.js'), 'generated');
    await setMtime(safePath, Date.now() - 8 * day);

    const { policy } = buildPolicy({ now: Date.now() });
    const report = await policy.enforce();

    expect(report.keptUnsafe).toEqual([expect.objectContaining({ path: unsafePath, jobId: unsafeJobId })]);
    expect(report.keptUnsafe[0].reasons.join(' ')).toMatch(/ignored non-regenerable files.*\.env/);
    expect(report.removed).toEqual([{ path: safePath, jobId: safeJobId, reason: 'age' }]);
    await expect(fsPromises.readFile(path.join(unsafePath, '.env'), 'utf8')).resolves.toBe('must survive');
  });

  it('keeps a clean parent when a nested submodule has an unpublished local branch commit', async() => {
    // risk: unpublished work in a nested .git-file submodule is invisible and destroyed with its clean parent
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    const childSource = path.join(outsideRoot, 'child-source');
    const childRemote = path.join(outsideRoot, 'child.git');
    await fsPromises.mkdir(childSource);
    initRepoWithRemote(childSource, childRemote);
    commit(childSource, 'child.txt', 'published');
    git(childSource, ['push', '-u', 'origin', 'main']);
    git(childRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    const parentRemote = path.join(outsideRoot, 'parent.git');
    initRepoWithRemote(workspacePath, parentRemote);
    git(workspacePath, ['-c', 'protocol.file.allow=always', 'submodule', 'add', childRemote, 'child']);
    git(workspacePath, ['commit', '-q', '-m', 'add child']);
    git(workspacePath, ['push', '-u', 'origin', 'main']);
    const childPath = path.join(workspacePath, 'child');
    git(childPath, ['config', 'user.email', 'test@sulladesktop.com']);
    git(childPath, ['config', 'user.name', 'Sulla Test']);
    git(childPath, ['checkout', '-q', '-b', 'unpublished']);
    commit(childPath, 'local.txt', 'only local');
    git(childPath, ['checkout', '-q', 'main']);
    await setMtime(workspacePath, Date.now() - 8 * day);

    const { policy } = buildPolicy({ now: Date.now() });
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(report.keptUnsafe[0].reasons.join(' ')).toMatch(/not reachable from any live remote ref.*\/child/);
    await expect(fsPromises.access(path.join(childPath, '.git'))).resolves.toBeUndefined();
  });

  it('keeps local commits after their live remote branch is deleted despite a stale tracking ref', async() => {
    // risk: cached refs/remotes falsely claim that deleted remote work still has custody
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    const remoteDir = path.join(outsideRoot, 'deleted-branch.git');
    pushedCleanRepo(workspacePath, remoteDir);
    git(remoteDir, ['update-ref', '-d', 'refs/heads/main']);
    await setMtime(workspacePath, Date.now() - 8 * day);

    const { policy } = buildPolicy({ now: Date.now() });
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(report.keptUnsafe[0].reasons.join(' ')).toMatch(/live remote origin has no refs|no live remote ref/);
    expect(execFileSync('git', ['show-ref', '--verify', 'refs/remotes/origin/main'], { cwd: workspacePath, encoding: 'utf8' })).toContain('origin/main');
  });

  it('restores a claimed workspace when its job becomes active during inspection', async() => {
    // risk: a resumed job loses its workspace between the first guard check and deletion
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    const remoteDir = path.join(outsideRoot, 'resume-race.git');
    pushedCleanRepo(workspacePath, remoteDir);
    await setMtime(workspacePath, Date.now() - 8 * day);
    const guard = new FixtureActiveJobGuard();
    const activatingGit = new ActivatingGitCommandRunner(new SpawnGitCommandRunner(), () => guard.markActive(jobId));
    const raceInspector = new WorkspaceInspector(fileSystem, activatingGit);

    const { policy, remover } = buildPolicy({ now: Date.now(), guard, inspector: raceInspector });
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    expect(remover.removedPaths).toEqual([]);
    await expect(fsPromises.readFile(path.join(workspacePath, 'a.txt'), 'utf8')).resolves.toBe('one');
    await expect(fsPromises.access(path.join(root, `.reclaiming-${ path.basename(workspacePath) }`))).rejects.toThrow();
  });

  it('restores a quarantine left by a crashed pass without deleting it in that pass', async() => {
    // risk: crash recovery converts an uncertain in-flight claim into automatic deletion
    const jobId = nextJobId();
    const originalPath = path.join(root, workspaceDirName(jobId));
    const quarantinedPath = path.join(root, `.reclaiming-${ path.basename(originalPath) }`);
    await fsPromises.mkdir(quarantinedPath);
    await fsPromises.writeFile(path.join(quarantinedPath, 'recover.txt'), 'keep');

    const { policy } = buildPolicy();
    const report = await policy.enforce();

    expect(report.removed).toEqual([]);
    await expect(fsPromises.readFile(path.join(originalPath, 'recover.txt'), 'utf8')).resolves.toBe('keep');
  });


  it('never reclaims running, parked, waiting-on-children, or unknown jobs', async() => {
    // risk: an active manager loses its workspace while children are still running
    const jobs = new FixtureJobStateReader();
    for (const [status, waiting] of [['running', 0], ['parked', 2], ['completed', 1]] as Array<[string, number]>) {
      const jobId = nextJobId();
      await fsPromises.mkdir(path.join(root, workspaceDirName(jobId)));
      jobs.set(jobId, { status, waitingOnChildren: waiting, finishedAt: Date.now() - 30 * day });
    }
    await fsPromises.mkdir(path.join(root, workspaceDirName(nextJobId()))); // deliberately unknown
    const report = await buildPolicy({ jobs, now: Date.now(), retentionWindowMs: 1 }).policy.enforce();
    expect(report.removed).toEqual([]);
  });

  it('reclaims pushed completed work after ten minutes but keeps failed work inside its window', async() => {
    // risk: published work fills disk, or failed diagnostic state disappears too early
    const jobs = new FixtureJobStateReader();
    const completedId = nextJobId();
    const completedPath = path.join(root, workspaceDirName(completedId));
    await fsPromises.mkdir(completedPath);
    pushedCleanRepo(completedPath, path.join(outsideRoot, 'completed.git'));
    jobs.set(completedId, { status: 'completed', finishedAt: Date.now() - 11 * 60_000 });
    const failedId = nextJobId();
    const failedPath = path.join(root, workspaceDirName(failedId));
    await fsPromises.mkdir(failedPath);
    await fsPromises.writeFile(path.join(failedPath, 'diagnostic.txt'), 'keep');
    jobs.set(failedId, { status: 'failed', finishedAt: Date.now() - 23 * 60 * 60_000 });
    const report = await buildPolicy({ jobs, now: Date.now() }).policy.enforce();
    expect(report.removed.map(item => item.jobId)).toEqual([completedId]);
    await expect(fsPromises.access(failedPath)).resolves.toBeUndefined();
  });

  it('preserves unpushed failed work before age deletion and under low disk pressure', async() => {
    // risk: disk recovery silently destroys the only copy of a worker's changes
    const jobs = new FixtureJobStateReader();
    const recovery = new FixtureRecoveryPreserver();
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    initRepoWithRemote(workspacePath, path.join(outsideRoot, 'unsafe.git'));
    commit(workspacePath, 'only-local.txt', 'valuable');
    jobs.set(jobId, { status: 'failed', finishedAt: Date.now() - 30 * day });
    const report = await buildPolicy({ jobs, recovery, now: Date.now(), diskFreeBytes: 0, minFreeDiskBytes: 1 }).policy.enforce();
    expect(recovery.preserved).toEqual([jobId]);
    expect(report.removed).toEqual([{ path: workspacePath, jobId, reason: 'age' }]);
  });


  it('protects an unknown workspace younger than 24 hours', async() => {
    // risk: a registry persistence race deletes a workspace whose job is not visible yet
    const jobs = new FixtureJobStateReader();
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    await setMtime(workspacePath, Date.now() - 23 * 60 * 60_000);
    const report = await buildPolicy({ jobs, now: Date.now() }).policy.enforce();
    expect(report.removed).toEqual([]);
    await expect(fsPromises.access(workspacePath)).resolves.toBeUndefined();
  });

  it('reclaims an unknown pushed workspace older than 24 hours as an orphan', async() => {
    // risk: deleted/pre-persistence job rows leave published workspaces in the backlog forever
    const jobs = new FixtureJobStateReader();
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    pushedCleanRepo(workspacePath, path.join(outsideRoot, 'orphan-clean.git'));
    await setMtime(workspacePath, Date.now() - 25 * 60 * 60_000);
    const report = await buildPolicy({ jobs, now: Date.now() }).policy.enforce();
    expect(report.removed).toEqual([{ path: workspacePath, jobId, reason: 'orphan' }]);
  });

  it('archives an unknown unsafe workspace older than 24 hours before orphan removal', async() => {
    // risk: reclaiming orphan backlog silently destroys commits that exist only inside the VM
    const jobs = new FixtureJobStateReader();
    const recovery = new FixtureRecoveryPreserver();
    const jobId = nextJobId();
    const workspacePath = path.join(root, workspaceDirName(jobId));
    await fsPromises.mkdir(workspacePath);
    initRepoWithRemote(workspacePath, path.join(outsideRoot, 'orphan-unsafe.git'));
    commit(workspacePath, 'only-local.txt', 'valuable');
    await setMtime(workspacePath, Date.now() - 25 * 60 * 60_000);
    const report = await buildPolicy({ jobs, recovery, now: Date.now() }).policy.enforce();
    expect(recovery.preserved).toEqual([jobId]);
    expect(report.removed).toEqual([{ path: workspacePath, jobId, reason: 'orphan' }]);
  });

});
