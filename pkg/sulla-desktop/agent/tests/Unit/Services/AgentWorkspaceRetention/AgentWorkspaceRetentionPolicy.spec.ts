// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeWorkspaceFileSystem, SpawnGitCommandRunner, WorkspaceInspector } from '../../../../services/AgentWorkspaceInspector';
import {
  AgentWorkspaceRetentionPolicy,
  type ActiveJobGuard,
  type DiskSpaceProbe,
  type RetentionClock,
  type WorkspaceRemover,
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

class FixtureDiskSpaceProbe implements DiskSpaceProbe {
  constructor(private bytes: number) {}
  async freeBytes(): Promise<number> { return this.bytes }
}

class FixtureWorkspaceRemover implements WorkspaceRemover {
  readonly removedPaths: string[] = [];
  private readonly failing = new Set<string>();
  private readonly freedBytesByPath = new Map<string, number>();

  failFor(targetPath: string): void { this.failing.add(targetPath) }
  freeBytesFor(targetPath: string, bytes: number): void { this.freedBytesByPath.set(targetPath, bytes) }

  async remove(targetPath: string): Promise<number | undefined> {
    if (this.failing.has(targetPath)) throw new Error(`simulated delete failure for ${ targetPath }`);
    await fsPromises.rm(targetPath, { recursive: true, force: true });
    this.removedPaths.push(targetPath);
    return this.freedBytesByPath.get(targetPath);
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
  } = {}) {
    const clock = new FixtureClock(options.now ?? Date.now());
    const guard = options.guard ?? new FixtureActiveJobGuard();
    const diskSpaceProbe = new FixtureDiskSpaceProbe(options.diskFreeBytes ?? Number.MAX_SAFE_INTEGER);
    const remover = options.remover ?? new FixtureWorkspaceRemover();
    const config = new WorkspaceRetentionConfig({
      retentionWindowMs: options.retentionWindowMs,
      minFreeDiskBytes:  options.minFreeDiskBytes,
    });
    const policy = new AgentWorkspaceRetentionPolicy(root, fileSystem, inspector, guard, clock, diskSpaceProbe, remover, config);
    return { policy, clock, guard, diskSpaceProbe, remover };
  }

  it('removes a clean workspace of a terminal job', async() => {
    // risk: 2,071 retained workspaces at 8.4 GB never get swept away; disk fills again
    const jobId = nextJobId();
    const dirName = workspaceDirName(jobId);
    const workspacePath = path.join(root, dirName);
    await fsPromises.mkdir(workspacePath);
    await fsPromises.writeFile(path.join(workspacePath, 'notes.txt'), 'scratch output, no git');

    const { policy, remover } = buildPolicy();
    const report = await policy.enforce();

    expect(report.removed).toEqual([{ path: workspacePath, jobId, reason: 'clean' }]);
    expect(remover.removedPaths).toContain(workspacePath);
    await expect(fsPromises.access(workspacePath)).rejects.toThrow();
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
    expect(report.keptUnsafe[0].reasons.join(' ')).toMatch(/not reachable from any remote-tracking ref/);
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
    expect(report.keptUnsafe[0].reasons.join(' ')).toMatch(/feature has no remote-tracking ref/);
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
    await fsPromises.writeFile(path.join(workspaceA, 'notes.txt'), 'scratch');

    const jobIdB = nextJobId();
    const workspaceB = path.join(root, workspaceDirName(jobIdB));
    await fsPromises.mkdir(workspaceB);
    await fsPromises.writeFile(path.join(workspaceB, 'notes.txt'), 'scratch');

    const remover = new FixtureWorkspaceRemover();
    remover.failFor(workspaceA);
    const { policy } = buildPolicy({ remover });
    const report = await policy.enforce();

    expect(report.errors).toEqual([{ path: workspaceA, error: `simulated delete failure for ${ workspaceA }` }]);
    expect(report.removed).toEqual([{ path: workspaceB, jobId: jobIdB, reason: 'clean' }]);
    await expect(fsPromises.access(workspaceA)).resolves.toBeUndefined();
    await expect(fsPromises.access(workspaceB)).rejects.toThrow();
  });
});
