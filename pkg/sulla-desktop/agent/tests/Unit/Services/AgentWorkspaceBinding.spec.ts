// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentWorkspaceBinder } from '../../../services/AgentWorkspaceBinding';
import { ensureGuestWorktreeDirectories, GUEST_CONVERSATIONS_ROOT, seedGitWorktreeIntoStableGuest } from '../../../services/GuestRuntimeTransport';

const guest = vi.hoisted(() => ({ root: '', freeKiB: 99999999, assumeDifferentGitOwner: false }));
vi.mock('node:child_process', async(importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    // Execute the real guest initialization command in an isolated directory.
    // Remap only guest filesystem constants and provide deterministic df output.
    execFile: (_binary: string, args: string[], options: Parameters<typeof actual.execFile>[2], callback: any) => {
      const [program, ...command] = args.slice(2).map(arg => arg
        .replaceAll('/mnt/worktrees', `${ guest.root }/worktrees`)
        .replaceAll('/mnt/data/sulla/runtime', `${ guest.root }/runtime`));
      (options as any).env = {
        ...(options as any).env, PATH: `${ guest.root }/bin:${ process.env.PATH }`, GUEST_FREE_KIB: String(guest.freeKiB),
        ...(guest.assumeDifferentGitOwner ? { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' } : {}),
      };
      return actual.execFile(program, command, options as any, (error, stdout, stderr) => {
        callback(error, String(stdout).replaceAll(`${ guest.root }/runtime`, '/mnt/data/sulla/runtime'), stderr);
      });
    },
  };
});
vi.mock('electron', () => ({ default: { app: { getVersion: () => 'test' } } }));

const operations = () => ({
  createEphemeral: vi.fn((jobKey: string) => Promise.resolve(`/runtime/agents/${ jobKey }-random`)),
  seedEphemeral:   vi.fn((_source: string, jobKey: string) => Promise.resolve(`/runtime/agents/${ jobKey }-seeded`)),
  prepareStableSource: vi.fn(() => Promise.resolve()),
  seedStable:      vi.fn((_source: string, stable: string) => Promise.resolve(stable)),
});

describe('durable Git workspace initialization', () => {
  const target = `${ GUEST_CONVERSATIONS_ROOT }/task/workspace`;
  const local = (name: string) => path.join(guest.root, name);
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const sourceRemote = 'https://github.example.test/team/repo.git';
  function legacyCheckout(name: string): string {
    const agents = local('runtime/agents');
    mkdirSync(agents, { recursive: true });
    const checkout = path.join(agents, name);
    git(agents, 'clone', local('worktrees/repo'), checkout);
    git(checkout, 'remote', 'set-url', 'origin', sourceRemote);
    return checkout;
  }

  beforeEach(() => {
    guest.root = mkdtempSync(path.join(realpathSync(tmpdir()), 'sulla-c1-workspace-'));
    guest.freeKiB = 99999999;
    guest.assumeDifferentGitOwner = false;
    mkdirSync(local('runtime/conversations/task/workspace'), { recursive: true });
    mkdirSync(local('worktrees/repo'), { recursive: true });
    mkdirSync(local('bin'));
    writeFileSync(local('bin/df'), '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 999999999 1 %s 1%% /\\n" "$GUEST_FREE_KIB"\n', { mode: 0o700 });
    const source = local('worktrees/repo');
    git(source, 'init', '-b', 'worker-branch');
    writeFileSync(path.join(source, 'marker'), 'committed');
    git(source, 'add', 'marker');
    git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture');
    git(source, 'remote', 'add', 'origin', sourceRemote);
  });

  afterEach(() => rmSync(guest.root, { recursive: true, force: true }));

  it('reopens the same branch, commit and uncommitted bytes after the source moves', async() => {
    const source = local('worktrees/repo');
    const workspace = local('runtime/conversations/task/workspace');
    const expectedHead = git(source, 'rev-parse', 'HEAD');
    mkdirSync(local('runtime/conversations/task/.workspace-initializing'));
    writeFileSync(local('runtime/conversations/task/.workspace-initializing/partial'), 'interrupted clone');

    await expect(Promise.all([
      seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target),
      seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target),
    ])).resolves.toEqual([target, target]);
    writeFileSync(path.join(workspace, 'marker'), 'uncommitted progress');
    rmSync(source, { recursive: true });
    guest.assumeDifferentGitOwner = true;
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target, 'job-1-0')).resolves.toBe(target);
    expect(git(workspace, 'symbolic-ref', '--short', 'HEAD')).toBe('worker-branch');
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(expectedHead);
    expect(readFileSync(path.join(workspace, 'marker'), 'utf8')).toBe('uncommitted progress');
  });

  it('preserves an exact pre-marker durable Git workspace during restart recovery', async() => {
    const source = local('worktrees/repo');
    const workspace = local('runtime/conversations/task/workspace');
    rmSync(workspace, { recursive: true });
    git(path.dirname(workspace), 'clone', source, workspace);
    writeFileSync(path.join(workspace, 'uncommitted.txt'), 'restart-safe bytes');
    rmSync(source, { recursive: true });

    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target, 'job-1-0')).resolves.toBe(target);
    expect(readFileSync(path.join(workspace, 'uncommitted.txt'), 'utf8')).toBe('restart-safe bytes');
  });

  it('does not treat an arbitrary nonempty folder as a recoverable durable workspace', async() => {
    writeFileSync(local('runtime/conversations/task/workspace/unrelated.txt'), 'not a checkout');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target, 'job-1-0'))
      .rejects.toThrow('refusing an unbound non-Git stable workspace');
    expect(readFileSync(local('runtime/conversations/task/workspace/unrelated.txt'), 'utf8')).toBe('not a checkout');
  });

  it('fails before publishing a workspace when the clone would cross the VM disk reserve', async() => {
    guest.freeKiB = 4096;
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).rejects.toMatchObject({ name: 'GuestDiskFullError' });
    expect(() => readFileSync(local('runtime/conversations/task/workspace/marker'))).toThrow(/ENOENT/);
  });

  it('reopens the exact legacy checkout after verifying source history and origin', async() => {
    const legacy = legacyCheckout('repo-worker-branch-job-1-0-a1b2c3d4');
    writeFileSync(path.join(legacy, 'marker'), 'uncommitted progress');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target, 'job-1-0'))
      .resolves.toBe('/mnt/data/sulla/runtime/agents/repo-worker-branch-job-1-0-a1b2c3d4');
    expect(readFileSync(path.join(legacy, 'marker'), 'utf8')).toBe('uncommitted progress');
  });

  it('ignores another task whose key ends in the recovering job key', async() => {
    const other = legacyCheckout('repo-worker-branch-foo-job-1-0-a1b2c3d4');
    writeFileSync(path.join(other, 'marker'), 'unrelated progress');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target, 'job-1-0')).resolves.toBe(target);
    expect(readFileSync(local('runtime/conversations/task/workspace/marker'), 'utf8')).toBe('committed');
    expect(readFileSync(path.join(other, 'marker'), 'utf8')).toBe('unrelated progress');
  });

  it('rejects multiple exact legacy matches without changing them', async() => {
    legacyCheckout('repo-worker-branch-job-1-0-a1b2c3d4');
    legacyCheckout('repo-worker-branch-job-1-0-a2b3c4d5');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target, 'job-1-0')).rejects.toThrow('single safe retained checkout');
    expect(existsSync(local('runtime/conversations/task/workspace/.git'))).toBe(false);
  });

  it('rejects an exact name collision from a different Git origin', async() => {
    const other = legacyCheckout('repo-worker-branch-job-1-0-a1b2c3d4');
    git(other, 'remote', 'set-url', 'origin', 'https://github.example.test/team/other.git');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target, 'job-1-0')).rejects.toThrow('single safe retained checkout');
    expect(existsSync(local('runtime/conversations/task/workspace/.git'))).toBe(false);
  });

  it('retries a failed first seed even when no legacy checkout exists', async() => {
    const stage = local('runtime/conversations/task/.workspace-initializing');
    guest.freeKiB = 4096;
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).rejects.toMatchObject({ name: 'GuestDiskFullError' });
    mkdirSync(stage);
    writeFileSync(path.join(stage, 'partial'), 'left by an interrupted first seed');
    guest.freeKiB = 99999999;
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target, 'job-1-0')).resolves.toBe(target);
    expect(existsSync(stage)).toBe(false);
    writeFileSync(local('runtime/conversations/task/workspace/marker'), 'work after retry');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target, 'job-1-0')).resolves.toBe(target);
    expect(readFileSync(local('runtime/conversations/task/workspace/marker'), 'utf8')).toBe('work after retry');
  });

  it('repairs only the private scratch directory and preserves the root owner and mode', async() => {
    const root = local('worktrees');
    const scratch = path.join(root, '_scratch');
    chmodSync(root, 0o750);
    mkdirSync(scratch, { mode: 0o755 });
    const before = statSync(root);
    await ensureGuestWorktreeDirectories({ uid: before.uid, gid: before.gid });
    expect(statSync(root)).toMatchObject({ uid: before.uid, gid: before.gid, mode: before.mode, ctimeMs: before.ctimeMs });
    expect(statSync(scratch)).toMatchObject({ uid: before.uid, gid: before.gid });
    expect(statSync(scratch).mode & 0o777).toBe(0o700);
  });

  it('rejects a symlink at the worktree root or scratch path', async() => {
    const root = local('worktrees');
    const before = statSync(root);
    const identity = { uid: before.uid, gid: before.gid };
    const outside = local('outside');
    renameSync(root, outside);
    symlinkSync(outside, root);
    await expect(ensureGuestWorktreeDirectories(identity)).rejects.toThrow();
    expect(existsSync(path.join(outside, '_scratch'))).toBe(false);
    rmSync(root);
    mkdirSync(root);
    symlinkSync(outside, path.join(root, '_scratch'));
    await expect(ensureGuestWorktreeDirectories(identity)).rejects.toThrow();
    expect(statSync(outside).mode).toBe(before.mode);
  });
});

describe('AgentWorkspaceBinder', () => {
  it('initializes an explicit seed inside the stable delegated workspace', async() => {
    // risk: every wake clones the seed into a new random workspace and loses prior edits.
    const ports = operations();
    const result = await AgentWorkspaceBinder.bind({ jobKey: 'job-1-0', source: '/mnt/worktrees/repo', stableWorkspace: '/runtime/conversations/key/workspace' }, ports);

    expect(result).toBe('/runtime/conversations/key/workspace');
    expect(ports.prepareStableSource).toHaveBeenCalledOnce();
    expect(ports.seedStable).toHaveBeenCalledWith('/mnt/worktrees/repo', '/runtime/conversations/key/workspace', undefined);
    expect(ports.seedEphemeral).not.toHaveBeenCalled();
  });

  it('reopens an unseeded stable workspace without allocating another directory', async() => {
    const ports = operations();
    expect(await AgentWorkspaceBinder.bind({ jobKey: 'job-1-0', stableWorkspace: '/runtime/conversations/key/workspace' }, ports))
      .toBe('/runtime/conversations/key/workspace');
    expect(ports.createEphemeral).not.toHaveBeenCalled();
    expect(ports.prepareStableSource).not.toHaveBeenCalled();
  });

  it('retains the legacy ephemeral behavior only for a lifecycle without a persistence key', async() => {
    const ports = operations();
    expect(await AgentWorkspaceBinder.bind({ jobKey: 'job-1-0', source: '/mnt/worktrees/repo' }, ports))
      .toBe('/runtime/agents/job-1-0-seeded');
    expect(ports.seedEphemeral).toHaveBeenCalledOnce();
    expect(ports.prepareStableSource).not.toHaveBeenCalled();
  });

  it('allocates ordinary ephemeral workspaces when stable source preparation is unavailable', async() => {
    const ports = operations();
    ports.prepareStableSource.mockRejectedValue(new Error('worktree root unavailable'));
    await expect(AgentWorkspaceBinder.bind({ jobKey: 'chat-1-0' }, ports)).resolves.toBe('/runtime/agents/chat-1-0-random');
    expect(ports.prepareStableSource).not.toHaveBeenCalled();
  });
});
