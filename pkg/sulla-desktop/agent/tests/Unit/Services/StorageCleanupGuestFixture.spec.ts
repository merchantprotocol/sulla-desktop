// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  claimGuestWorkspace,
  GUEST_CLAIM_PROTOCOL,
  guestWorkspaceClaimId,
  liveWorkspaceClaimSnapshot,
  WORKSPACE_CLAIM_INSTANCE,
} from '@pkg/agent/services/GuestWorkspaceClaim';
import {
  inspectStorageCleanupFixture,
  removeStorageCleanupFixture,
  scanStorageCleanupFixture,
  type GuestRunner,
  type GuestStorageCandidate,
} from '@pkg/main/storageCleanup/StorageCleanupGuest';
import {
  MemoryStorageCleanupReceiptStore,
  StorageCleanupService,
  type StorageCleanupDependencies,
} from '@pkg/main/storageCleanup/StorageCleanupService';

const exec = promisify(execFile);
const FIXTURE_PARENT = '/private/tmp/sulla-storage-cleanup-tests';
const created:string[] = [];
const GIT_ENV = { ...process.env, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

const runner:GuestRunner = async(args) => {
  try {
    return (await exec(args[0], args.slice(1), { env: GIT_ENV, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch (error:any) {
    throw Object.assign(new Error(String(error?.stderr || error?.message || error)), {
      exitCode: typeof error?.code === 'number' ? error.code : undefined,
    });
  }
};

async function git(repository:string, ...args:string[]):Promise<string> {
  return (await exec('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'user.name=Cleanup Fixture',
    '-c', 'user.email=cleanup-fixture@example.invalid', '-C', repository, ...args,
  ], { env: GIT_ENV })).stdout.trim();
}

async function repository(root:string):Promise<string> {
  await fs.mkdir(root, { recursive: true });
  await git(root, 'init');
  await fs.writeFile(path.join(root, 'source.txt'), 'published source\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  await git(root, 'add', 'source.txt', '.gitignore');
  await git(root, 'commit', '-m', 'fixture source');
  await git(root, 'branch', '-M', 'feature/fixture');
  await git(root, 'tag', 'fixture-v1');
  await git(root, 'remote', 'add', 'origin', 'git@github.com:merchantprotocol/sulla-desktop.git');
  return root;
}

async function allocatedBytes(root:string, skipGit = false):Promise<number> {
  const seen = new Set<string>();
  const stack = [root];
  let bytes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    const info = await fs.lstat(current);
    const key = `${ info.dev }:${ info.ino }`;
    if (!seen.has(key)) {
      seen.add(key);
      bytes += (info.blocks ?? 0) * 512;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    for (const name of await fs.readdir(current)) {
      if (skipGit && current === root && name === '.git') continue;
      stack.push(path.join(current, name));
    }
  }
  return bytes;
}

async function newFixture():Promise<string> {
  await fs.mkdir(FIXTURE_PARENT, { recursive: true });
  const fixture = await fs.mkdtemp(`${ FIXTURE_PARENT }/run-`);
  created.push(fixture);
  await dockerContainers(fixture, []);
  return fixture;
}

/** Test double for the guest container runtime: lists the given containers and their mount sources. */
async function dockerContainers(fixture:string, containers:{ name: string; mounts?: string[] }[] | 'unavailable'):Promise<void> {
  const bin = path.join(fixture, 'bin');
  await fs.mkdir(bin, { recursive: true });
  const list = containers === 'unavailable' ? [] : containers;
  await fs.writeFile(path.join(bin, 'ids'), list.map((_, index) => `${ String(index + 1).padStart(12, 'a') }\n`).join(''));
  await fs.writeFile(path.join(bin, 'inspect'), list.map(item => [`/${ item.name }`, ...(item.mounts ?? [])].join('\t')).join('\n'));
  await fs.writeFile(path.join(bin, 'docker'), [
    '#!/bin/sh',
    'dir=$(dirname "$0")',
    containers === 'unavailable' ? 'exit 1' : '',
    'case "$1" in ps) cat "$dir/ids";; inspect) cat "$dir/inspect";; *) exit 2;; esac',
  ].join('\n'), { mode: 0o755 });
}

function deleteRequest(candidate:GuestStorageCandidate) {
  return {
    path:           candidate.path,
    workspaceRoot:  candidate.workspaceRoot,
    source:         candidate.source,
    identity:       candidate.identity,
    gitFingerprint: candidate.repository.fingerprint,
  };
}

function claimOptions(fixture:string) {
  return {
    runner,
    claimsRoot: path.join(fixture, 'claims'),
    roots:      [path.join(fixture, 'agents'), path.join(fixture, 'conversations')],
  };
}

/** Runs the shared claim protocol in a separate real OS process that the test can SIGKILL. */
function protocolProcess(program:string):{ ready: Promise<void>; kill(): Promise<void> } {
  const child = spawn('python3', ['-c', `${ GUEST_CLAIM_PROTOCOL }\nimport sys\n${ program }`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('ready')) resolve();
    });
    child.once('exit', code => reject(new Error(`claim process exited ${ code } before ready`)));
  });
  return {
    ready,
    async kill() {
      child.kill('SIGKILL');
      await exited;
    },
  };
}

afterEach(async() => {
  while (created.length) {
    const target = created.pop()!;
    if (!target.startsWith(`${ FIXTURE_PARENT }/`)) throw new Error('Refusing to remove a fixture outside the owned root');
    await exec('chmod', ['-R', 'u+rwX', target]).catch(() => undefined);
    await fs.rm(target, { recursive: true, force: true });
  }
});

describe('Storage cleanup guest scanner with real Git fixtures', () => {
  it('accounts for refs, stashes, ignored files, nested repositories and conversation child repositories', async() => {
    const fixture = await newFixture();
    const agent = await repository(path.join(fixture, 'agents', 'agent-repo'));
    await fs.mkdir(path.join(agent, 'node_modules', 'fixture'), { recursive: true });
    await fs.writeFile(path.join(agent, 'node_modules', 'fixture', 'index.js'), 'ignored\n');
    await fs.writeFile(path.join(agent, 'source.txt'), 'stashed source\n');
    await git(agent, 'stash', 'push', '-m', 'fixture stash');
    await repository(path.join(agent, 'nested-repo'));
    await fs.symlink('/tmp', path.join(agent, 'unsafe-link'));
    const symlinkGit = path.join(fixture, 'agents', 'symlink-git');
    await fs.mkdir(symlinkGit, { recursive: true });
    await fs.symlink(path.join(agent, '.git'), path.join(symlinkGit, '.git'));
    const linkedGit = path.join(fixture, 'agents', 'linked-worktree-metadata');
    await fs.mkdir(linkedGit, { recursive: true });
    await fs.writeFile(path.join(linkedGit, '.git'), `gitdir: ${ path.join(agent, '.git') }\n`);

    const persistenceHash = 'a'.repeat(32);
    const conversationRepository = await repository(path.join(fixture, 'conversations', persistenceHash, 'workspace', 'repo'));
    const scan = await scanStorageCleanupFixture(fixture, runner);
    const agentCandidate = scan.candidates.find(item => item.path === agent)!;
    const conversationCandidate = scan.candidates.find(item => item.path === conversationRepository)!;
    const symlinkGitCandidate = scan.candidates.find(item => item.path === symlinkGit)!;
    const linkedGitCandidate = scan.candidates.find(item => item.path === linkedGit)!;

    expect(scan.errors).toEqual([]);
    expect(agentCandidate.repository.localBranches).toEqual([expect.objectContaining({ name: 'feature/fixture' })]);
    expect(agentCandidate.repository.localTags).toEqual([expect.objectContaining({ name: 'fixture-v1' })]);
    expect(agentCandidate.repository.stashCommits).toHaveLength(1);
    // Ignored trees are reported as one directory entry, not one entry per file.
    expect(agentCandidate.repository.ignoredEntries).toEqual(['node_modules/']);
    expect(agentCandidate.repository.nestedRepositories).toContain('nested-repo');
    expect(agentCandidate.allocatedBytes).toBe(await allocatedBytes(agent));
    expect(agentCandidate.allocatedBytes!).toBeGreaterThan(await allocatedBytes(agent, true));
    expect(agentCandidate.contentVerified).toBe(false);
    expect(symlinkGitCandidate.repository.error).toContain('non-directory Git metadata');
    expect(linkedGitCandidate.repository.error).toContain('Linked worktrees');
    expect(conversationCandidate).toMatchObject({
      source:             'conversation-child',
      persistenceKeyHash: persistenceHash,
      workspaceRoot:      path.join(fixture, 'conversations', persistenceHash, 'workspace'),
      contentVerified:    true,
    });
  });

  it('bounds large dirty listings to counted samples and keeps measuring when content is not verified', async() => {
    const fixture = await newFixture();
    const dirty = await repository(path.join(fixture, 'agents', 'many-untracked'));
    await Promise.all(Array.from({ length: 300 }, (_, index) => fs.writeFile(path.join(dirty, `untracked-${ index }.txt`), `${ index }\n`)));
    const unreadable = await repository(path.join(fixture, 'agents', 'unreadable'));
    await fs.chmod(path.join(unreadable, 'source.txt'), 0o000);

    const scan = await scanStorageCleanupFixture(fixture, runner);
    const dirtyCandidate = scan.candidates.find(item => item.path === dirty)!;
    const unreadableCandidate = scan.candidates.find(item => item.path === unreadable)!;
    expect(dirtyCandidate.repository.counts.dirtyEntries).toBe(300);
    expect(dirtyCandidate.repository.dirtyEntries.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(dirtyCandidate).length).toBeLessThan(20_000);
    // Disk usage stays visible even when content cannot be verified; eligibility fails closed.
    expect(dirtyCandidate.allocatedBytes).toBe(await allocatedBytes(dirty));
    expect(dirtyCandidate.contentVerified).toBe(false);
    expect(unreadableCandidate.allocatedBytes).toBe(await allocatedBytes(unreadable));
    expect(unreadableCandidate.contentVerified).toBe(false);
  });

  it('isolates one candidate whose inspection fails from the rest of the inventory', async() => {
    const fixture = await newFixture();
    const healthy = await repository(path.join(fixture, 'agents', 'healthy'));
    const stuck = await repository(path.join(fixture, 'agents', 'stuck'));
    const flaky:GuestRunner = (args, input, timeout) => (args[3] === 'inspect' && args[4].includes('/stuck"')
      ? Promise.reject(new Error('guest command timed out'))
      : runner(args, input, timeout));
    const scan = await scanStorageCleanupFixture(fixture, flaky);
    expect(scan.errors).toEqual([]);
    expect(scan.candidates.find(item => item.path === healthy)).toMatchObject({ allocatedBytes: await allocatedBytes(healthy) });
    expect(scan.candidates.find(item => item.path === stuck)).toMatchObject({
      allocatedBytes: null,
      scanError:      expect.stringContaining('did not complete'),
    });
  });

  it('submits commits held only by non-branch refs for proof and retains replacement refs', async() => {
    const fixture = await newFixture();
    const keep = await repository(path.join(fixture, 'agents', 'custom-refs'));
    await fs.writeFile(path.join(keep, 'local.txt'), 'local only\n');
    await git(keep, 'add', 'local.txt');
    await git(keep, 'commit', '-m', 'local only');
    const localOnly = await git(keep, 'rev-parse', 'HEAD');
    await git(keep, 'update-ref', 'refs/keep/saved', localOnly);
    await git(keep, 'update-ref', 'refs/remotes/origin/expired', localOnly);
    await git(keep, 'reset', '--hard', 'HEAD~1');
    // Reflogs gone and nothing unreachable: only the refs themselves hold the commit.
    await git(keep, 'reflog', 'expire', '--expire=now', '--all');
    const replaced = await repository(path.join(fixture, 'agents', 'replace-ref'));
    await git(replaced, 'update-ref', `refs/replace/${ await git(replaced, 'rev-parse', 'HEAD') }`, await git(replaced, 'rev-parse', 'HEAD'));

    const scan = await scanStorageCleanupFixture(fixture, runner);
    const keepCandidate = scan.candidates.find(item => item.path === keep)!;
    expect(keepCandidate.repository.reflogOnlyCommits).toEqual([]);
    expect(keepCandidate.repository.unreachableObjects).toEqual([]);
    expect(keepCandidate.repository.extraRefs).toEqual(expect.arrayContaining([
      { name: 'refs/keep/saved', commitSha: localOnly },
      { name: 'refs/remotes/origin/expired', commitSha: localOnly },
    ]));
    expect(scan.candidates.find(item => item.path === replaced)!.repository.unsupportedRefs).toEqual([expect.stringMatching(/^refs\/replace\//)]);
  });

  it('retains an unpublished stash whose reflog is gone when branch history does not contain the tip', async() => {
    const fixture = await newFixture();
    const agent = await repository(path.join(fixture, 'agents', 'stash-without-reflog'));
    await fs.writeFile(path.join(agent, 'source.txt'), 'unique unpublished stash readme\n');
    await git(agent, 'stash', 'push', '-m', 'unique readme');
    const stashTip = await git(agent, 'rev-parse', '--verify', 'refs/stash');
    const published = new Set((await git(agent, 'rev-list', '--branches', '--tags')).split('\n').filter(Boolean));
    expect(published.has(stashTip)).toBe(false);
    await fs.rm(path.join(agent, '.git', 'logs', 'refs', 'stash'));
    await expect(fs.access(path.join(agent, '.git', 'logs', 'refs', 'stash'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(agent, 'status', '--porcelain')).toBe('');

    const candidate = (await scanStorageCleanupFixture(fixture, runner)).candidates.find(item => item.path === agent)!;
    expect(candidate.repository.stashCommits).toEqual([stashTip]);
    expect(candidate.repository.counts.stashCommits).toBe(1);
    expect(candidate.repository.dirtyEntries).toEqual([]);
    expect(candidate.repository.ignoredEntries).toEqual([]);
    expect(candidate.repository.unreachableObjects).toEqual([]);
    expect(candidate.repository.localScripts).toEqual([]);

    const result = await removeStorageCleanupFixture(deleteRequest(candidate), fixture, runner);
    expect(result).toMatchObject({ status: 'failed', removedBytes: 0, removedEntries: 0 });
    await expect(fs.readFile(path.join(agent, 'source.txt'), 'utf8')).resolves.toBe('published source\n');
    expect(await git(agent, 'rev-parse', '--verify', 'refs/stash')).toBe(stashTip);
    expect(await git(agent, 'show', `${ stashTip }:source.txt`)).toBe('unique unpublished stash readme');
  });

  it('counts hard-linked data shared outside the checkout as allocated but not recoverable', async() => {
    const fixture = await newFixture();
    const linked = await repository(path.join(fixture, 'agents', 'hardlinked'));
    const outside = path.join(fixture, 'outside.bin');
    await fs.writeFile(outside, Buffer.alloc(64 * 1024, 7));
    await fs.link(outside, path.join(linked, 'shared.bin'));
    await git(linked, 'add', 'shared.bin');
    await git(linked, 'commit', '-m', 'shared data');
    const candidate = (await scanStorageCleanupFixture(fixture, runner)).candidates.find(item => item.path === linked)!;
    const sharedBlocks = ((await fs.lstat(outside)).blocks ?? 0) * 512;
    expect(sharedBlocks).toBeGreaterThan(0);
    expect(candidate.allocatedBytes).toBe(await allocatedBytes(linked));
    expect(candidate.recoverableBytes).toBe(candidate.allocatedBytes! - sharedBlocks);
  });

  it('retains shared Git primaries and independently rejects worktree metadata added after review', async() => {
    const fixture = await newFixture();
    const primaryHash = 'b'.repeat(32);
    const linkedHash = 'c'.repeat(32);
    const primary = await repository(path.join(fixture, 'conversations', primaryHash, 'workspace', 'primary'));
    const linked = path.join(fixture, 'conversations', linkedHash, 'workspace', 'linked');
    await fs.mkdir(path.dirname(linked), { recursive: true });
    await git(primary, 'worktree', 'add', '-b', 'linked-fixture', linked, 'HEAD');

    const sharedScan = await scanStorageCleanupFixture(fixture, runner);
    const primaryCandidate = sharedScan.candidates.find(item => item.path === primary)!;
    const linkedCandidate = sharedScan.candidates.find(item => item.path === linked)!;
    expect(primaryCandidate.repository.worktreeMetadata).toEqual([expect.stringContaining('.git/worktrees/')]);
    expect(primaryCandidate.repository.error).toContain('shared Git primary');
    expect(linkedCandidate.repository.error).toContain('Linked worktrees');

    const reviewed = await repository(path.join(fixture, 'agents', 'worktree-race'));
    const reviewedCandidate = (await scanStorageCleanupFixture(fixture, runner)).candidates.find(item => item.path === reviewed)!;
    const racedLink = path.join(fixture, 'conversations', 'd'.repeat(32), 'workspace', 'linked-after-review');
    await fs.mkdir(path.dirname(racedLink), { recursive: true });
    await git(reviewed, 'worktree', 'add', '-b', 'linked-after-review', racedLink, 'HEAD');

    await expect(removeStorageCleanupFixture(deleteRequest(reviewedCandidate), fixture, runner)).resolves.toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('shared Git primary'),
    });
    await expect(fs.stat(reviewed)).resolves.toBeTruthy();
    await expect(fs.stat(racedLink)).resolves.toBeTruthy();
  });

  it('keeps the conversation container on cancel and removes only a confirmed inactive child repository', async() => {
    const fixture = await newFixture();
    const persistenceKey = 'storage-cleanup-fixture-conversation';
    const persistenceHash = crypto.createHash('sha256').update(persistenceKey).digest('hex').slice(0, 32);
    const conversationRoot = path.join(fixture, 'conversations', persistenceHash);
    const workspaceRoot = path.join(conversationRoot, 'workspace');
    const childRepository = await repository(path.join(workspaceRoot, 'repo'));
    const retainedCheckpoint = path.join(conversationRoot, 'provider-home', 'checkpoint.json');
    await fs.mkdir(path.dirname(retainedCheckpoint), { recursive: true });
    await fs.writeFile(retainedCheckpoint, '{"retained":true}\n');
    await fs.writeFile(path.join(workspaceRoot, 'retained-workspace-metadata.json'), '{}\n');

    let sequence = 0;
    let fullScans = 0;
    const receipts = new MemoryStorageCleanupReceiptStore();
    const dependencies:StorageCleanupDependencies = {
      scanGuest:    () => { fullScans++; return scanStorageCleanupFixture(fixture, runner) },
      inspectGuest: ref => inspectStorageCleanupFixture(ref, fixture, runner),
      removeGuest:  request => removeStorageCleanupFixture(request, fixture, runner),
      authority:    () => Promise.resolve({
        jobs:          [],
        conversations: [{
          id:           'conversation-1',
          threadId:     'thread-1',
          channelId:    'channel-1',
          title:        'Fixture conversation',
          lastActiveAt: '2026-11-01T00:00:00.000Z',
          metadata:     { containerPersistenceKey: persistenceKey },
        }],
        projectTasks:    [],
        filesProjects:   [],
        fileReferences:  [],
        runtimeReady:    true,
        runtimeBindings: [],
      }),
      prove: repositoryState => Promise.resolve({
        status:   'verified',
        evidence: repositoryState.localBranches.map(item => ({
          repository:      'merchantprotocol/sulla-desktop',
          localCommitSha:  item.commitSha,
          remoteRef:       `refs/heads/${ item.name }`,
          remoteCommitSha: item.commitSha,
        })),
      }),
      receipts,
      now:      () => new Date('2026-11-17T12:00:00.000Z'),
      randomId: () => `fixture-${ ++sequence }`,
    };
    const service = new StorageCleanupService(dependencies);
    const inventory = await service.inventory();
    const target = inventory.targets.find(item => item.path === childRepository)!;
    expect(target).toMatchObject({ assessment: 'eligible', selectable: true, source: 'conversation-child' });

    const cancelledPlan = await service.plan({ targetIds: [target.id] });
    expect(await service.cancel(cancelledPlan.id)).toMatchObject({ status: 'cancelled', removedBytes: 0 });
    await expect(fs.stat(childRepository)).resolves.toBeTruthy();

    const confirmedPlan = await service.plan({ targetIds: [target.id] });
    const scansBeforeExecute = fullScans;
    const receipt = await service.execute(confirmedPlan.id);
    expect(receipt).toMatchObject({ status: 'completed' });
    expect(fullScans).toBe(scansBeforeExecute);
    await expect(fs.stat(childRepository)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(retainedCheckpoint, 'utf8')).resolves.toContain('retained');
    await expect(fs.stat(workspaceRoot)).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(workspaceRoot, 'retained-workspace-metadata.json'), 'utf8')).resolves.toBe('{}\n');
    await expect(fs.readdir(path.join(fixture, 'claims'))).resolves.toEqual(['.mutex']);
  });

  it('never removes outside the exact conversation workspace boundary', async() => {
    const fixture = await newFixture();
    const stable = path.join(fixture, 'conversations', 'e'.repeat(32));
    const child = await repository(path.join(stable, 'workspace', 'repo'));
    const candidate = (await scanStorageCleanupFixture(fixture, runner)).candidates.find(item => item.path === child)!;
    await expect(removeStorageCleanupFixture({ ...deleteRequest(candidate), workspaceRoot: stable }, fixture, runner))
      .resolves.toMatchObject({ status: 'blocked', reason: expect.stringContaining('boundary') });
    await expect(removeStorageCleanupFixture({ ...deleteRequest(candidate), path: path.join(stable, 'workspace') }, fixture, runner))
      .resolves.toMatchObject({ status: 'blocked', reason: expect.stringContaining('boundary') });
    await expect(fs.stat(child)).resolves.toBeTruthy();
  });

  it('blocks removal while a live launch holds the workspace and proceeds after release', async() => {
    const fixture = await newFixture();
    const agent = await repository(path.join(fixture, 'agents', 'claimed-repo'));
    const candidate = (await scanStorageCleanupFixture(fixture, runner)).candidates.find(item => item.path === agent)!;
    const claim = await claimGuestWorkspace(agent, 'sulla-agent-live', claimOptions(fixture));

    await expect(removeStorageCleanupFixture(deleteRequest(candidate), fixture, runner)).resolves.toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('agent launch owns'),
    });
    await expect(fs.stat(agent)).resolves.toBeTruthy();
    await claim.release();
    await expect(removeStorageCleanupFixture(deleteRequest(candidate), fixture, runner)).resolves.toMatchObject({ status: 'removed' });
  });

  it('protects a workspace still mounted by a running container and fails closed when containers cannot be listed', async() => {
    const fixture = await newFixture();
    const agent = await repository(path.join(fixture, 'agents', 'mounted'));
    const candidate = (await scanStorageCleanupFixture(fixture, runner)).candidates.find(item => item.path === agent)!;
    await dockerContainers(fixture, [{ name: 'detached-worker', mounts: [agent] }]);
    await expect(removeStorageCleanupFixture(deleteRequest(candidate), fixture, runner)).resolves.toMatchObject({
      status: 'blocked', reason: expect.stringContaining('still mounts'),
    });
    await dockerContainers(fixture, 'unavailable');
    await expect(removeStorageCleanupFixture(deleteRequest(candidate), fixture, runner)).resolves.toMatchObject({
      status: 'blocked', reason: expect.stringContaining('Container inventory is unavailable'),
    });
    await expect(fs.stat(agent)).resolves.toBeTruthy();
  });

  it('recovers a launch claim left by a crashed Desktop process while its container is gone', async() => {
    const fixture = await newFixture();
    const agent = await repository(path.join(fixture, 'agents', 'crashed-owner'));
    const candidate = (await scanStorageCleanupFixture(fixture, runner)).candidates.find(item => item.path === agent)!;
    const claims = path.join(fixture, 'claims');
    // A prior Desktop process acquires its launch claim, then dies by SIGKILL without releasing.
    const crashed = protocolProcess([
      `acquire_launch(${ JSON.stringify(claims) }, ${ JSON.stringify(agent) }, ${ JSON.stringify(crypto.randomUUID()) }, "crashed-instance", "sulla-agent-crashed", 1, 5)`,
      'print("ready", flush=True)',
      'time.sleep(60)',
    ].join('\n'));
    await crashed.ready;
    await crashed.kill();
    const holderDirectory = path.join(claims, guestWorkspaceClaimId(agent));
    expect((await fs.readdir(holderDirectory)).filter(name => name.startsWith('launch-'))).toHaveLength(1);

    // The restarted Desktop launches the same workspace normally.
    const relaunch = await claimGuestWorkspace(agent, 'sulla-agent-relaunched', claimOptions(fixture));
    await relaunch.release();

    // While the prior container still exists (detached worker), the claim stays protected.
    await dockerContainers(fixture, [{ name: 'sulla-agent-crashed' }]);
    await expect(removeStorageCleanupFixture(deleteRequest(candidate), fixture, runner)).resolves.toMatchObject({ status: 'blocked' });
    // Once that container is provably gone, the dead holder is reclaimed and cleanup proceeds.
    await dockerContainers(fixture, []);
    await expect(removeStorageCleanupFixture(deleteRequest(candidate), fixture, runner)).resolves.toMatchObject({ status: 'removed' });
    await expect(fs.stat(holderDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('treats this process\'s released holder as dead but a holder registered after the snapshot as live', async() => {
    const fixture = await newFixture();
    const agent = await repository(path.join(fixture, 'agents', 'snapshot-race'));
    const candidate = (await scanStorageCleanupFixture(fixture, runner)).candidates.find(item => item.path === agent)!;
    const failingRelease:GuestRunner = (args, input, timeout) => (args[3]?.includes('"release"') ? Promise.reject(new Error('exec channel lost')) : runner(args, input, timeout));

    const staleSnapshot = liveWorkspaceClaimSnapshot(agent);
    const late = await claimGuestWorkspace(agent, 'sulla-agent-late', { ...claimOptions(fixture), runner: failingRelease });
    await expect(removeStorageCleanupFixture(deleteRequest(candidate), fixture, runner, staleSnapshot)).resolves.toMatchObject({ status: 'blocked' });
    await expect(late.release()).rejects.toThrow('exec channel lost');
    expect(liveWorkspaceClaimSnapshot(agent).liveTokens).toEqual([]);
    await expect(removeStorageCleanupFixture(deleteRequest(candidate), fixture, runner)).resolves.toMatchObject({ status: 'removed' });
    expect(liveWorkspaceClaimSnapshot(agent).instance).toBe(WORKSPACE_CLAIM_INSTANCE);
  });

  it('makes a retried acquire with the same token idempotent', async() => {
    const fixture = await newFixture();
    const agent = await repository(path.join(fixture, 'agents', 'retried'));
    // The transport delivered the first acquire, lost the reply, and retried it verbatim.
    const retried:GuestRunner = async(args, input, timeout) => {
      if (args[3]?.includes('"acquire"')) await runner(args, input, timeout);
      return runner(args, input, timeout);
    };
    const claim = await claimGuestWorkspace(agent, 'sulla-agent-retried', { ...claimOptions(fixture), runner: retried });
    const directory = path.join(fixture, 'claims', guestWorkspaceClaimId(agent));
    expect((await fs.readdir(directory)).filter(name => name.startsWith('launch-'))).toHaveLength(1);
    await claim.release();
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('queues a launch behind a live cleanup and recovers when the cleanup process is SIGKILLed', async() => {
    const fixture = await newFixture();
    const agent = await repository(path.join(fixture, 'agents', 'cleanup-killed'));
    const claims = path.join(fixture, 'claims');
    const cleanup = protocolProcess([
      `lock, reason = acquire_cleanup(${ JSON.stringify(claims) }, ${ JSON.stringify(agent) }, "cleanup-instance", set(), 0, set())`,
      'assert lock is not None, reason',
      'print("ready", flush=True)',
      'time.sleep(60)',
    ].join('\n'));
    await cleanup.ready;

    await expect(claimGuestWorkspace(agent, 'sulla-agent-impatient', { ...claimOptions(fixture), waitMs: 0 }))
      .rejects.toThrow('cleanup is still in progress');
    expect(liveWorkspaceClaimSnapshot(agent).liveTokens).toEqual([]);

    const queued = claimGuestWorkspace(agent, 'sulla-agent-queued', { ...claimOptions(fixture), waitMs: 20_000 });
    await new Promise(resolve => setTimeout(resolve, 700));
    await cleanup.kill();
    const claim = await queued;
    const directory = path.join(claims, guestWorkspaceClaimId(agent));
    const entries = await fs.readdir(directory);
    expect(entries).not.toContain('cleanup.lock');
    expect(entries.filter(name => name.startsWith('launch-'))).toHaveLength(1);
    await claim.release();
  }, 30_000);

  it('aborts without unlinking when data or refs appear between proof and the removal snapshot', async() => {
    const fixture = await newFixture();
    const agent = await repository(path.join(fixture, 'agents', 'written-during-proof'));
    const realGit = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
    const gitBin = path.join(fixture, 'gitbin');
    await fs.mkdir(gitBin, { recursive: true });
    // Real Git, plus a deterministic writer that fires inside verification's last Git call once armed.
    await fs.writeFile(path.join(gitBin, 'git'), [
      '#!/bin/sh',
      'dir=$(dirname "$0")',
      'for arg in "$@"; do',
      '  if [ "$arg" = "--stage" ] && [ -f "$dir/arm" ]; then',
      '    target=$(cat "$dir/arm"); rm -f "$dir/arm"',
      '    printf "written after proof\\n" > "$target/late-unproven.txt"',
      '    mkdir -p "$target/.git/refs/keep"',
      `    ${ realGit } -C "$target" rev-parse HEAD > "$target/.git/refs/keep/late"`,
      '  fi',
      'done',
      `exec ${ realGit } "$@"`,
    ].join('\n'), { mode: 0o755 });
    const gapRunner:GuestRunner = async(args) => {
      try {
        return (await exec(args[0], args.slice(1), { env: { ...GIT_ENV, PATH: `${ gitBin }:${ process.env.PATH }` }, maxBuffer: 8 * 1024 * 1024 })).stdout;
      } catch (error:any) {
        throw new Error(String(error?.stderr || error?.message || error));
      }
    };
    const candidate = (await scanStorageCleanupFixture(fixture, gapRunner)).candidates.find(item => item.path === agent)!;
    expect(candidate.contentVerified).toBe(true);
    await fs.writeFile(path.join(gitBin, 'arm'), agent);

    await expect(removeStorageCleanupFixture(deleteRequest(candidate), fixture, gapRunner)).resolves.toMatchObject({
      status:       'failed',
      removedBytes: 0,
      reason:       expect.stringMatching(/Nothing was removed: Workspace changed during verification/),
    });
    await expect(fs.access(path.join(gitBin, 'arm'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(agent, 'late-unproven.txt'), 'utf8')).resolves.toBe('written after proof\n');
    await expect(fs.readFile(path.join(agent, '.git', 'refs', 'keep', 'late'), 'utf8')).resolves.toMatch(/^[0-9a-f]{40}/);
    await expect(fs.readFile(path.join(agent, 'source.txt'), 'utf8')).resolves.toBe('published source\n');
  });

  it('reports a truthful partial outcome and keeps repository metadata when removal fails midway', async() => {
    const fixture = await newFixture();
    const agent = await repository(path.join(fixture, 'agents', 'partial-io'));
    await fs.mkdir(path.join(agent, 'locked'));
    await fs.writeFile(path.join(agent, 'locked', 'kept.txt'), 'kept\n');
    await git(agent, 'add', 'locked/kept.txt');
    await git(agent, 'commit', '-m', 'locked data');
    // A read-only directory makes the unlink inside it fail with a real EACCES.
    await fs.chmod(path.join(agent, 'locked'), 0o555);
    const candidate = (await scanStorageCleanupFixture(fixture, runner)).candidates.find(item => item.path === agent)!;
    expect(candidate.contentVerified).toBe(true);
    const gitignoreBytes = ((await fs.lstat(path.join(agent, '.gitignore'))).blocks ?? 0) * 512;

    const result = await removeStorageCleanupFixture(deleteRequest(candidate), fixture, runner);
    expect(result).toMatchObject({
      status:         'partial',
      removedEntries: 1,
      removedBytes:   gitignoreBytes,
      reason:         expect.stringContaining(`retained at ${ agent }`),
    });
    expect(result.reason).toMatch(/Permission denied/);
    expect(typeof result.guestFreeSpaceDeltaBytes).toBe('number');
    await expect(fs.access(path.join(agent, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(agent, 'locked', 'kept.txt'), 'utf8')).resolves.toBe('kept\n');
    await expect(fs.readFile(path.join(agent, 'source.txt'), 'utf8')).resolves.toBe('published source\n');
    await expect(fs.stat(path.join(agent, '.git', 'HEAD'))).resolves.toBeTruthy();
    // The cleanup claim is released, so later chat or worker launches are never blocked.
    await expect(fs.readdir(path.join(fixture, 'claims'))).resolves.toEqual(['.mutex']);
  });

  it('retains a clean pushed checkout with an unpublished local hook while a pristine clone stays clean', async() => {
    const fixture = await newFixture();
    const source = await repository(path.join(fixture, 'source-repo'));
    const pristine = path.join(fixture, 'agents', 'pristine-clone');
    const hooked = path.join(fixture, 'agents', 'hooked-clone');
    const sample = path.join(fixture, 'agents', 'modified-sample');
    const aliased = path.join(fixture, 'agents', 'shell-alias');
    for (const target of [pristine, hooked, sample, aliased]) await exec('git', ['clone', '--quiet', '--no-hardlinks', source, target], { env: GIT_ENV });
    await fs.writeFile(path.join(hooked, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho unique local hook code\n', { mode: 0o755 });
    await fs.appendFile(path.join(sample, '.git', 'hooks', 'pre-push.sample'), '\n# local edit\n');
    await git(aliased, 'config', '--local', 'alias.ship', '!./scripts/local-only.sh');

    const scan = await scanStorageCleanupFixture(fixture, runner);
    const byPath = (target:string) => scan.candidates.find(item => item.path === target)!;
    expect(byPath(pristine).repository.localScripts).toEqual([]);
    expect(byPath(pristine).contentVerified).toBe(true);
    expect(byPath(hooked).repository.localScripts).toEqual(['hooks/pre-commit']);
    expect(byPath(hooked).contentVerified).toBe(false);
    expect(byPath(sample).repository.localScripts).toEqual(['hooks/pre-push.sample (modified or unrecognized sample)']);
    expect(byPath(aliased).repository.localScripts).toEqual(['config alias.ship']);
    await expect(fs.readFile(path.join(hooked, '.git', 'hooks', 'pre-commit'), 'utf8')).resolves.toContain('unique local hook code');
  });

  it('never removes a replacement installed at the reviewed path', async() => {
    const fixture = await newFixture();
    const agent = await repository(path.join(fixture, 'agents', 'replace-me'));
    const candidate = (await scanStorageCleanupFixture(fixture, runner)).candidates.find(item => item.path === agent)!;
    await fs.rename(agent, `${ agent }.reviewed`);
    await fs.mkdir(agent);
    const replacement = path.join(agent, 'replacement.txt');
    await fs.writeFile(replacement, 'must survive\n');

    const result = await removeStorageCleanupFixture(deleteRequest(candidate), fixture, runner);
    expect(result).toMatchObject({ status: 'failed', reason: expect.stringContaining('identity changed') });
    await expect(fs.readFile(replacement, 'utf8')).resolves.toBe('must survive\n');
  });
});
