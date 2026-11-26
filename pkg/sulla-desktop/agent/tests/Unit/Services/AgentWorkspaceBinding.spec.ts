// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentWorkspaceBinder } from '../../../services/AgentWorkspaceBinding';
import { ensureGuestWorktreeDirectories, GUEST_CONVERSATIONS_ROOT, seedGitWorktreeIntoStableGuest as productionSeed } from '../../../services/GuestRuntimeTransport';

const guest = vi.hoisted(() => ({ root: '', freeKiB: 99999999, assumeDifferentGitOwner: false }));
vi.mock('node:child_process', async(importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    // Execute the real guest initialization command in an isolated directory.
    // Remap only guest filesystem constants and provide deterministic df output.
    execFile: (_binary: string, args: string[], options: Parameters<typeof actual.execFile>[2], callback: any) => {
      const [program, ...command] = args.slice(2).map(arg => arg
        // CI has neither CAP_SYS_ADMIN nor a Docker socket. Substitute only bind(2)
        // and the Docker executable; the broker, reader, publisher and Git are real.
        .replaceAll('/bin/df', `${ guest.root }/bin/df`)
        .replaceAll('/usr/bin/docker', `${ guest.root }/bin/docker`)
        .replaceAll('/proc/self/mountinfo', `${ guest.root }/mountinfo`)
        .replace('main(MountPins)', readFileSync(path.resolve('pkg/sulla-desktop/agent/tests/Support/stable-seed-pins.py'), 'utf8').trimEnd().replaceAll('\n', '\n    '))
        .replaceAll('/mnt/data/.sulla-stable-seed', `${ guest.root }/.sulla-stable-seed`)
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
  const uid = process.getuid!() || 65534;
  const gid = process.getgid!() || 65534;
  const seedGitWorktreeIntoStableGuest = (source: string, workspace: string, job?: string, identity = async() => ({ uid, gid })) =>
    productionSeed(source, workspace, job, { image: 'seed-fixture', identity });
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
    writeFileSync(local('mountinfo'), '1 0 8:1 / / rw - ext4 /dev/root rw\n');
    copyFileSync(path.resolve('pkg/sulla-desktop/agent/tests/Support/stable-seed-container.py'), local('bin/docker'));
    chmodSync(local('bin/docker'), 0o700);
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

  it('seeds an in-root linked worktree from its registered external primary checkout only', async() => {
    const primary = local('primary');
    renameSync(local('worktrees/repo'), primary);
    const linked = local('worktrees/linked');
    git(primary, 'worktree', 'add', '-b', 'delegated', linked);
    const impostor = local('worktrees/impostor');
    mkdirSync(impostor);
    writeFileSync(path.join(impostor, '.git'), readFileSync(path.join(linked, '.git')));

    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/impostor', target)).rejects.toThrow();
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/linked', target)).resolves.toBe(target);
    const workspace = local('runtime/conversations/task/workspace');
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('delegated');
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(git(linked, 'rev-parse', 'HEAD'));
    expect(git(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(path.join(workspace, '.git'));
  });

  it.each(['branch', 'detached'])('seeds only approved %s history on first use with mixed ownership', async(mode) => {
    const source = local('worktrees/repo');
    const workspace = local('runtime/conversations/task/workspace');
    git(source, 'checkout', '-b', 'unpublished');
    writeFileSync(path.join(source, 'other'), 'unpublished fixture');
    git(source, 'add', 'other');
    git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'other history');
    const unrelated = git(source, 'rev-parse', 'HEAD');
    git(source, 'checkout', 'worker-branch');
    if (mode === 'detached') git(source, 'checkout', '--detach', 'HEAD');
    const approved = git(source, 'rev-parse', 'HEAD');
    guest.assumeDifferentGitOwner = true;

    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).resolves.toBe(target);

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(approved);
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(mode === 'detached' ? 'HEAD' : 'worker-branch');
    expect(git(workspace, 'for-each-ref', '--format=%(refname)')).not.toContain('unpublished');
    expect(() => git(workspace, 'cat-file', '-e', unrelated)).toThrow();
  });

  it('seeds a clean opaque gitlink without fetching its contents', async() => {
    const source = local('worktrees/repo');
    const workspace = local('runtime/conversations/task/workspace');
    const absent = '1'.repeat(40);
    writeFileSync(path.join(source, '.gitmodules'),
      '[submodule "dep"]\n\tpath = dep\n\turl = https://example.invalid/absent.git\n');
    mkdirSync(path.join(source, 'dep'));
    git(source, 'add', '.gitmodules');
    git(source, 'update-index', '--add', '--cacheinfo', `160000,${ absent },dep`);
    git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'gitlink');
    expect(git(source, 'status', '--porcelain')).toBe('');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).resolves.toBe(target);
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(git(source, 'rev-parse', 'HEAD'));
    expect(git(workspace, 'ls-tree', 'HEAD', 'dep')).toBe(`160000 commit ${ absent }\tdep`);
    expect(git(workspace, 'submodule', 'status')).toMatch(/^-/);
    expect(existsSync(path.join(workspace, '.git/modules'))).toBe(false);
    expect(() => git(workspace, 'cat-file', '-e', absent)).toThrow();
  });

  it.each(['changed HEAD', 'edited file', 'staged edit', 'untracked file'])('seeds an initialized submodule when clean but refuses its %s', async(state) => {
    const source = local('worktrees/repo');
    const dep = path.join(source, 'deps/dep');
    const commit = (dir: string, ...args: string[]) =>
      git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture', ...args);
    git(source, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'lib', source, 'deps/dep');
    if (state === 'staged edit' || state === 'untracked file') git(source, 'config', '-f', '.gitmodules', 'submodule.lib.ignore', 'all');
    git(source, 'add', '.gitmodules');
    commit(source);
    expect(readFileSync(path.join(dep, '.git'), 'utf8')).toContain('.git/modules/lib');
    expect(git(source, 'status', '--porcelain', '--ignore-submodules=none')).toBe('');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).resolves.toBe(target);
    const workspace = local('runtime/conversations/task/workspace');
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(git(source, 'rev-parse', 'HEAD'));
    expect(existsSync(path.join(workspace, 'deps/dep/.git'))).toBe(false);

    if (state === 'changed HEAD') commit(dep, '--allow-empty');
    if (state === 'edited file' || state === 'staged edit') writeFileSync(path.join(dep, 'marker'), 'changed');
    if (state === 'staged edit') git(dep, 'add', 'marker');
    if (state === 'untracked file') writeFileSync(path.join(dep, 'untracked'), 'changed');
    expect(git(source, 'status', '--porcelain', '--ignore-submodules=none')).not.toBe('');
    mkdirSync(local('runtime/conversations/next/workspace'), { recursive: true });
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', `${ GUEST_CONVERSATIONS_ROOT }/next/workspace`)).rejects.toThrow();
    expect(existsSync(local('runtime/conversations/next/workspace/.git'))).toBe(false);
  });

  it('seeds the approved HEAD without interpreting checkout-local Git configuration', async() => {
    const repo = local('worktrees/repo');
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'config', 'core.bare', 'true');
    // Inert positive control: this exact repository config changes Git semantics.
    expect(git(repo, 'rev-parse', '--is-bare-repository')).toBe('true');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).resolves.toBe(target);
    expect(git(local('runtime/conversations/task/workspace'), 'rev-parse', 'HEAD')).toBe(head);
    const calls: Array<{ argv: string[]; operation: string }> = readFileSync(local('helper-calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.map(call => call.operation)).toContain('publish');
    for (const { argv, operation } of calls) {
      expect(uid).toBeGreaterThan(0);
      expect(argv[argv.indexOf('--user') + 1]).toBe(`${ uid }:${ gid }`);
      expect(argv[argv.indexOf('--network') + 1]).toBe('none');
      expect(argv).toEqual(expect.arrayContaining(['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint=/usr/bin/env']));
      const mounts = argv.filter((_, i) => argv[i - 1] === '--mount');
      const writable = mounts.filter(m => !m.endsWith(',readonly'));
      if (operation === 'publish') {
        expect(mounts).toHaveLength(2);
        expect(writable).toHaveLength(1);
        expect(writable[0]).toContain('dst=/seed/stage,');
      } else {
        expect(writable).toEqual([]);
        expect(mounts.every(m => m.includes('dst=/seed/'))).toBe(true);
      }
    }
  });

  it.each([0, undefined])('refuses missing or privileged reader identity (%s)', async(badUid) => {
    const repo = local('worktrees/repo');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target, undefined,
      async() => ({ uid: badUid as number, gid }))).rejects.toThrow(/identity/i);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('worker-branch');
    expect(existsSync(local('runtime/conversations/task/workspace/.git'))).toBe(false);
  });

  it.each(['extra ref', 'different head'])('rejects a frozen bundle with %s before publication', async(kind) => {
    const repo = local('worktrees/repo');
    git(repo, 'branch', 'extra');
    if (kind === 'different head') {
      git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'other');
    }
    git(repo, 'bundle', 'create', local('substitute.bundle'), 'refs/heads/worker-branch',
      ...(kind === 'extra ref' ? ['refs/heads/extra'] : []));
    if (kind === 'different head') git(repo, 'reset', '--hard', 'extra');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).rejects.toThrow('publish');
    expect(existsSync(local('runtime/conversations/task/workspace/.git'))).toBe(false);
  });

  it('refuses a replaced empty target and leaves the prior directory untouched', async() => {
    writeFileSync(local('swap'), '');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).rejects.toThrow('target changed');
    expect(existsSync(local('runtime/conversations/task/workspace/.git'))).toBe(false);
    expect(existsSync(local('runtime/conversations/task/prior/.git'))).toBe(false);
  });

  it('reconciles a killed run before seeding without crossing its mounted source', async() => {
    const baseline = readFileSync(local('mountinfo'), 'utf8') +
      `9 1 8:1 /other ${ local('.sulla-stable-seed-other') } rw - ext4 /dev/root rw\n`;
    writeFileSync(local('mountinfo'), baseline);
    mkdirSync(local('external-source'));
    writeFileSync(local('external-source/sentinel'), 'untouched');
    writeFileSync(local('kill-on-publish'), '');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).rejects.toThrow();
    const abandoned = readFileSync(local('abandoned-stage'), 'utf8');
    expect(existsSync(abandoned)).toBe(true);
    const run = path.basename(path.dirname(abandoned));
    const calls = readFileSync(local('helper-calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line).argv as string[]);
    expect(calls.every(argv => argv.includes(`com.sulla.stable-seed.run=${ run }`))).toBe(true);
    expect(readFileSync(local('mountinfo'), 'utf8').split('\n').length).toBe(baseline.split('\n').length + 1);

    // The kernel can refuse a detach. The record, stage and mounted bytes must survive for retry.
    writeFileSync(local('deny-detach'), '');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).rejects.toThrow();
    expect(existsSync(abandoned)).toBe(true);
    expect(readFileSync(path.join(path.dirname(abandoned), 'pin-interrupted space/sentinel'), 'utf8')).toBe('untouched');
    rmSync(local('deny-detach'));
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).resolves.toBe(target);
    expect(readFileSync(local('mountinfo'), 'utf8')).toBe(baseline);
    expect(existsSync(path.dirname(abandoned))).toBe(false);
    expect(readFileSync(local('external-source/sentinel'), 'utf8')).toBe('untouched');
    expect(JSON.parse(readFileSync(local('helpers'), 'utf8'))).toEqual({ ['b'.repeat(64)]: 'unrelated' });
  });

  it('does not fall back to guest Git without an isolated reader', async() => {
    writeFileSync(local('offline'), '');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).rejects.toThrow('confined');
    expect(existsSync(local('runtime/conversations/task/workspace/.git'))).toBe(false);
  });

  it.each(['overflow', 'partial'])('discards a producer stream on %s without starting a publisher', async(fault) => {
    guest.freeKiB = 1024 * 1024 + 1024;
    writeFileSync(local(fault), '');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target))
      .rejects.toThrow(fault === 'overflow' ? /disk is full/i : /bundle failed/);
    expect(existsSync(local('runtime/conversations/task/workspace/.git'))).toBe(false);
    const calls = readFileSync(local('helper-calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line).operation);
    expect(calls).not.toContain('publish');
  });

  it('does not seed dirty source bytes even if the worker index assumes the file is unchanged', async() => {
    const repo = local('worktrees/repo');
    git(repo, 'update-index', '--assume-unchanged', 'marker');
    writeFileSync(path.join(repo, 'marker'), 'not committed');
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).rejects.toThrow('bundle failed');
    expect(existsSync(local('runtime/conversations/task/workspace/.git'))).toBe(false);
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

  it('seeds and reopens a credential-free origin with a percent-encoded path', async() => {
    const origin = 'https://example.invalid/team/My%20Project/_git/repo';
    const repo = local('worktrees/repo');
    const workspace = local('runtime/conversations/task/workspace');
    git(repo, 'remote', 'set-url', 'origin', origin);
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).resolves.toBe(target);
    expect(git(workspace, 'config', '--get', 'remote.origin.url')).toBe(origin);
    renameSync(repo, local('moved'));
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).resolves.toBe(target);
  });

  it.each([
    'https://person:example@example.invalid/r', 'https://@example.invalid/r',
    'https://example.invalid/a\nb', 'https://example.invalid/r%00', 'https://example.invalid/r%1F',
    'https://example.invalid/r%7f', 'https://example.invalid/r%2', 'https://example.invalid/r%xy',
    'https://example%40invalid/r', 'https://example.invalid:bad/r', 'file:///tmp/fixture',
    'https://example.invalid/repo?token=example',
  ])('rejects unsafe origin %# before publishing', async(origin) => {
    git(local('worktrees/repo'), 'remote', 'set-url', 'origin', origin);
    await expect(seedGitWorktreeIntoStableGuest('/mnt/worktrees/repo', target)).rejects.toThrow('inspect failed');
    expect(existsSync(local('runtime/conversations/task/workspace/.git'))).toBe(false);
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
    // Old staging was beneath a worker-writable parent. Never clean it as root.
    expect(readFileSync(path.join(stage, 'partial'), 'utf8')).toBe('left by an interrupted first seed');
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
