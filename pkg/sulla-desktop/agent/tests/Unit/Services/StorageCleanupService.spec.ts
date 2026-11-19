// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { StorageCleanupPreviewWorker } from '@pkg/agent/tools/ui/storage_cleanup_preview';
import type { GuestCandidateRef, GuestDeleteResult, GuestStorageCandidate } from '@pkg/main/storageCleanup/StorageCleanupGuest';
import {
  MemoryStorageCleanupReceiptStore,
  StorageCleanupService,
  proveGitHubReachabilityWithOctokit,
  readFilesProjects,
  type RemoteReachabilityResult,
  type StorageCleanupDependencies,
  type StorageCleanupReceipt,
} from '@pkg/main/storageCleanup/StorageCleanupService';

import type { AgentJob } from '../../../tools/agents/jobRegistry';

const SHA = '1'.repeat(40);
const SHA_TWO = '2'.repeat(40);
const SHA_THREE = '3'.repeat(40);

function candidate(name:string, repository:Partial<GuestStorageCandidate['repository']> = {}, extra:Partial<GuestStorageCandidate> = {}):GuestStorageCandidate {
  const path = `/mnt/data/sulla/runtime/agents/${ name }`;
  return {
    path,
    workspaceRoot:  path,
    source:         'agent',
    allocatedBytes:   4096,
    recoverableBytes: 4096,
    lastActivityAt:   '2026-11-01T00:00:00.000Z',
    identity:         { realPath: path, device: 1, inode: name.length + 10, mode: 16832, size: 128, modifiedNanoseconds: '10', contentFingerprint: `content-${ name }` },
    contentVerified:  true,
    repository:       {
      headSha:            SHA,
      detached:           false,
      currentBranch:      'feature',
      localBranches:      [{ name: 'feature', commitSha: SHA }],
      localTags:          [],
      extraRefs:          [],
      unsupportedRefs:    [],
      localScripts:       [],
      refsDigest:         `refs-${ name }`,
      reflogCommits:      [SHA],
      reflogOnlyCommits:  [],
      unreachableObjects: [],
      stashCommits:       [],
      dirtyEntries:       [],
      ignoredEntries:     [],
      remoteUrls:         ['git@github.com:merchant/repo.git'],
      worktreeMetadata:   [],
      submodules:         [],
      nestedRepositories: [],
      counts:             {},
      fingerprint:        `git-${ name }`,
      ...repository,
    },
    unsafeSymlinks: [],
    specialFiles:   [],
    mountPoints:    [],
    ...extra,
  };
}

function jobFor(workspacePath:string, status:AgentJob['status'] = 'completed', taskStatus:any = 'completed'):AgentJob {
  return {
    jobId:          `job-${ workspacePath.split('/').pop() }`,
    status,
    createdAt:      1,
    finishedAt:     status === 'completed' ? 2 : null,
    taskCount:      1,
    results:        [],
    parentThreadId: 'chat-1',
    projectTaskIds: ['task-1'],
    tasks:          [{ agentId: 'agent', label: 'work', prompt: 'work', status: taskStatus, workspacePath, taskId: 'task-1', threadId: 'child-1' }],
  };
}

function authority(jobs:AgentJob[], patch:Record<string, unknown> = {}) {
  return {
    jobs,
    conversations:   [{ id: 'chat-1', threadId: 'chat-1', channelId: 'channel-1', title: 'Cleanup chat', lastActiveAt: '2026-11-02T00:00:00.000Z', metadata: {} }],
    projectTasks:    [{ taskId: 'task-1', projectId: 'project-1', projectTitle: 'Storage project' }],
    filesProjects:   [],
    fileReferences:  [],
    runtimeReady:    true,
    runtimeBindings: [],
    ...patch,
  };
}

function verified(repository:GuestStorageCandidate['repository']):RemoteReachabilityResult {
  return {
    status:   'verified',
    evidence: [{ repository: 'merchant/repo', localCommitSha: repository.headSha!, remoteRef: 'refs/heads/feature', remoteCommitSha: repository.headSha! }],
  };
}

function harness(candidates:GuestStorageCandidate[], options:{ jobs?: AgentJob[]; prove?: (repository:GuestStorageCandidate['repository']) => Promise<RemoteReachabilityResult>; authorityPatch?: Record<string, unknown> } = {}) {
  const receipts = new MemoryStorageCleanupReceiptStore();
  let now = new Date('2026-11-17T12:00:00.000Z');
  let jobs = options.jobs ?? candidates.map(item => jobFor(item.path));
  let current = candidates;
  const removeGuest = vi.fn((_request:unknown) => Promise.resolve<GuestDeleteResult>({ status: 'removed', removedBytes: 4096, guestFreeSpaceDeltaBytes: 4096 }));
  const dependencies:StorageCleanupDependencies = {
    scanGuest:    vi.fn(() => Promise.resolve({ candidates: current, errors: [] })),
    inspectGuest: vi.fn((ref:GuestCandidateRef) => Promise.resolve(current.find(item => item.path === ref.path) ?? candidate('missing', {}, { ...ref, allocatedBytes: null, scanError: 'gone' }))),
    removeGuest,
    authority: vi.fn(() => Promise.resolve(authority(jobs, options.authorityPatch))) as any,
    prove:     options.prove ?? (repository => Promise.resolve(verified(repository))),
    receipts,
    now:       () => now,
    randomId:  vi.fn().mockReturnValueOnce('plan-1').mockReturnValueOnce('operation-1').mockReturnValue('next-id'),
  };
  const service = new StorageCleanupService(dependencies);
  return {
    service,
    dependencies,
    receipts,
    removeGuest,
    setJobs:       (value:AgentJob[]) => { jobs = value },
    setCandidates: (value:GuestStorageCandidate[]) => { current = value },
    advance:       (ms:number) => { now = new Date(now.getTime() + ms) },
  };
}

describe('StorageCleanupService eligibility', () => {
  it('keeps local-only source, ignored files, stashes and nested repositories while allowing pushed unmerged work', async() => {
    const clean = candidate('clean');
    const dirty = candidate('dirty', { dirtyEntries: [' M source.ts'] });
    const ignored = candidate('ignored', { ignoredEntries: ['node_modules/pkg/index.js'] });
    const stash = candidate('stash', { stashCommits: ['2'.repeat(40)] });
    const nested = candidate('nested', { nestedRepositories: ['vendor/other'] });
    const lost = candidate('lost', { unreachableObjects: [`unreachable commit ${ '4'.repeat(40) }`] });
    const { service } = harness([clean, dirty, ignored, stash, nested, lost]);
    const inventory = await service.inventory();
    expect(inventory.targets.find(item => item.path === clean.path)).toMatchObject({ assessment: 'eligible', selectable: true });
    expect(inventory.targets.find(item => item.path === dirty.path)).toMatchObject({ reasonCode: 'local-changes', selectable: false });
    expect(inventory.targets.find(item => item.path === ignored.path)).toMatchObject({ reasonCode: 'ignored-files', selectable: false });
    expect(inventory.targets.find(item => item.path === stash.path)).toMatchObject({ reasonCode: 'local-stash', selectable: false });
    expect(inventory.targets.find(item => item.path === nested.path)).toMatchObject({ reasonCode: 'nested-repository', selectable: false });
    expect(inventory.targets.find(item => item.path === lost.path)).toMatchObject({ reasonCode: 'lost-local-history', selectable: false });
  });

  it('treats unavailable auth or a missing current remote ref as unknown', async() => {
    const item = candidate('missing-ref', { reflogOnlyCommits: ['3'.repeat(40)] });
    const { service } = harness([item], { prove: () => Promise.resolve({ status: 'unknown', evidence: [], reason: 'Local reflog commit is not reachable from a current ref' }) });
    expect((await service.inventory()).targets[0]).toMatchObject({ assessment: 'unknown', reasonCode: 'remote-proof-unavailable', selectable: false });
  });

  it('protects active and paused owners and their workspace descendants without blocking unrelated inactive work', async() => {
    const workspaceRoot = '/mnt/data/sulla/runtime/conversations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/workspace';
    const active = candidate('active-child', {}, {
      path:               `${ workspaceRoot }/repo`,
      workspaceRoot,
      source:             'conversation-child',
      persistenceKeyHash: 'a'.repeat(32),
      identity:           { realPath: `${ workspaceRoot }/repo`, device: 1, inode: 100, mode: 16832, size: 128, modifiedNanoseconds: '10', contentFingerprint: 'active-child' },
    });
    const inactive = candidate('inactive');
    const { service } = harness([active, inactive], { jobs: [jobFor(workspaceRoot, 'parked', 'parked'), jobFor(inactive.path)] });
    const inventory = await service.inventory();
    expect(inventory.targets.find(item => item.path === active.path)).toMatchObject({ assessment: 'protected', reasonCode: 'active-owner' });
    expect(inventory.targets.find(item => item.path === inactive.path)).toMatchObject({ assessment: 'eligible', selectable: true });
  });

  it('protects retained recovery workspaces and open runtime bindings', async() => {
    const recoverable = candidate('recoverable');
    const open = candidate('open-runtime');
    const recoveryJob = jobFor(recoverable.path);
    recoveryJob.tasks[0].completion = {
      label:          'work',
      status:         'completed',
      output:         'done',
      threadId:       'child-1',
      cleanupReceipt: { removedGuestPaths: [], retainedGuestPaths: [recoverable.path], recoveryWorkspacePath: recoverable.path, workspaceDecisionReason: 'retained' },
    };
    const { service } = harness([recoverable, open], {
      jobs:           [recoveryJob, jobFor(open.path)],
      authorityPatch: { runtimeBindings: [{ jobId: 'live', workspacePath: open.path }] },
    });
    const inventory = await service.inventory();
    expect(inventory.targets.find(item => item.path === recoverable.path)).toMatchObject({ assessment: 'protected', reasonCode: 'recovery-owner' });
    expect(inventory.targets.find(item => item.path === open.path)).toMatchObject({ assessment: 'protected', reasonCode: 'active-owner' });
  });

  it('shows an unlinked pre-existing workspace as unknown instead of guessing from its title', async() => {
    const item = candidate('unlinked');
    const { service } = harness([item], { jobs: [] });
    expect((await service.inventory()).targets[0]).toMatchObject({ assessment: 'unknown', reasonCode: 'unlinked' });
  });

  it('uses Files-backed projects and structured message references when legacy project tables are empty', async() => {
    const item = candidate('files-project');
    const filesProject = {
      id:            'files:collection-1:storage-cleanup',
      label:         'storage-cleanup',
      path:          'Projects/storage-cleanup',
      projectFileId: 'project-file-1',
      collectionId:  'collection-1',
    };
    const { service } = harness([item], {
      jobs:           [jobFor(item.path)],
      authorityPatch: {
        projectTasks:   [],
        filesProjects:  [filesProject],
        fileReferences: [{
          conversationId: 'chat-1',
          fileId:         'project-spec-1',
          path:           '/mnt/sulla-files/Projects/storage-cleanup/spec.md',
          versionId:      'version-1',
          name:           'spec.md',
        }],
      },
    });
    const inventory = await service.inventory();
    expect(inventory.projects).toEqual([filesProject]);
    expect(inventory.targets[0]).toMatchObject({
      assessment:     'eligible',
      allocatedBytes: 4096,
      associations:   expect.arrayContaining([{ kind: 'project', id: filesProject.id, label: filesProject.label }]),
    });
  });

  it('does not let a Files project label authorize an otherwise unknown workspace owner', async() => {
    const item = candidate('project-only');
    const { service } = harness([item], {
      jobs:           [],
      authorityPatch: {
        filesProjects:  [{ id: 'files:c:p', label: 'p', path: 'Projects/p', projectFileId: 'pf', collectionId: 'c' }],
        fileReferences: [{ conversationId: 'chat-1', fileId: 'pf', path: 'Projects/p/PROJECT.md', versionId: 'v', name: 'PROJECT.md' }],
      },
    });
    expect((await service.inventory()).targets[0]).toMatchObject({ assessment: 'unknown', reasonCode: 'unlinked', selectable: false });
  });

  it('reports a scan error as unavailable rather than zero bytes', async() => {
    const item = candidate('scan-error', {}, { allocatedBytes: null, scanError: 'permission denied' });
    const { service } = harness([item]);
    const inventory = await service.inventory();
    expect(inventory.allocatedBytes).toBeNull();
    expect(inventory.targets[0]).toMatchObject({ measurement: 'scan-error', assessment: 'unknown' });
  });

  it('blocks a shared Git primary even when its owner is inactive and its commits are published', async() => {
    const item = candidate('shared-primary', {
      worktreeMetadata: ['.git/worktrees/linked-owner'],
      error:            'Repository is a shared Git primary with linked worktree metadata and is retained in this release',
    });
    const { service } = harness([item]);
    expect((await service.inventory()).targets[0]).toMatchObject({
      assessment: 'blocked',
      reasonCode: 'shared-git-metadata',
      selectable: false,
    });
  });

  it('keeps raw remotes only in the trusted proof call and redacts public inventory and errors', async() => {
    const marker = 'fixture-secret-must-not-leak';
    const item = candidate('credentialed-remote', {
      remoteUrls: [`https://${ marker }@github.com/merchant/repo.git?token=${ marker }#fragment`],
    });
    let proofSawRawRemote = false;
    const { service } = harness([item], {
      prove: repository => {
        proofSawRawRemote = repository.remoteUrls.some(remote => remote.includes(marker));
        return Promise.resolve({
          status:   'unknown',
          evidence: [],
          reason:   `Remote verification denied for ${ repository.remoteUrls[0] }`,
        });
      },
    });
    const inventory = await service.inventory();
    const serialized = JSON.stringify(inventory);
    expect(proofSawRawRemote).toBe(true);
    expect(serialized).not.toContain(marker);
    expect(inventory.targets[0].repository.remoteUrls).toEqual(['[unsupported or credentialed remote redacted]']);
    expect(inventory.targets[0]).toMatchObject({ assessment: 'unknown', reasonCode: 'remote-proof-unavailable' });
    const toolResult = await (new StorageCleanupPreviewWorker({
      inventory:      () => Promise.resolve(inventory),
      preparePreview: input => service.preparePreview(input),
    }, vi.fn()) as any)._validatedCall({ open: false });
    expect(JSON.stringify(toolResult)).not.toContain(marker);
    expect(toolResult.result.inventory).toBe(inventory);
  });
});

describe('Files-backed project catalog', () => {
  it('reads only visible home collection project records through the authenticated Files API', async() => {
    const client = {
      json: vi.fn(() => Promise.resolve([
        { id: 'home', kind: 'knowledge', systemArea: null, published: true, legacy_source: false },
        { id: 'logs', kind: 'knowledge', systemArea: 'logs', published: true, legacy_source: false },
        { id: 'scratch', kind: 'scratch', systemArea: null, agent_run_id: 'job-1' },
      ])),
      request: vi.fn((endpoint:string) => Promise.resolve(new Response(JSON.stringify(endpoint.includes('collectionId=home')
        ? [
          { id: 'project-1', collection_id: 'home', path: 'Projects/Alpha/PROJECT.md' },
          { id: 'notes-1', collection_id: 'home', path: 'Projects/Alpha/notes.md' },
        ]
        : []), { status: 200 }))),
    };
    await expect(readFilesProjects(client as any)).resolves.toEqual([{
      id: 'files:home:Alpha', label: 'Alpha', path: 'Projects/Alpha', projectFileId: 'project-1', collectionId: 'home',
    }]);
    expect(client.request).toHaveBeenCalledTimes(1);
  });
});

describe('GitHub current-ref reachability proof', () => {
  function octokit(refs:{ heads?: { ref: string; sha: string }[]; tags?: { ref: string; sha: string }[] }, compareStatus = 'diverged') {
    const listMatchingRefs = vi.fn();
    return {
      paginate: vi.fn((_method, input:{ ref: string }) => Promise.resolve(
        (input.ref === 'heads/' ? refs.heads ?? [] : refs.tags ?? []).map(item => ({
          ref:    item.ref,
          object: { type: 'commit', sha: item.sha },
        })),
      )),
      rest: {
        git: {
          listMatchingRefs,
          getTag: vi.fn(),
        },
        repos: {
          compareCommits: vi.fn(() => Promise.resolve({ data: { status: compareStatus } })),
        },
      },
    };
  }

  it('rejects an object that exists on GitHub but is not reachable from a surviving branch or tag', async() => {
    const repository = candidate('orphan-object', { localBranches: [{ name: 'deleted', commitSha: SHA }] }).repository;
    const result = await proveGitHubReachabilityWithOctokit(repository, octokit({
      heads: [{ ref: 'refs/heads/main', sha: SHA_TWO }],
    }));
    expect(result).toMatchObject({ status: 'unknown' });
    expect(result.reason).toContain('not reachable from a current GitHub branch or tag');
  });

  it('accepts pushed unmerged history and accounts for every local branch, tag and reflog-only tip', async() => {
    const repository = candidate('all-refs', {
      localBranches:     [{ name: 'feature/unmerged', commitSha: SHA }],
      localTags:         [{ name: 'saved', commitSha: SHA_TWO }],
      reflogOnlyCommits: [SHA_THREE],
    }).repository;
    const result = await proveGitHubReachabilityWithOctokit(repository, octokit({
      heads: [
        { ref: 'refs/heads/feature/unmerged', sha: SHA },
        { ref: 'refs/heads/recovered-history', sha: SHA_THREE },
      ],
      tags: [{ ref: 'refs/tags/saved', sha: SHA_TWO }],
    }));
    expect(result.status).toBe('verified');
    expect(result.evidence.map(item => item.localCommitSha).sort()).toEqual([SHA, SHA_TWO, SHA_THREE].sort());
  });

  it('accepts a clean detached checkout only when its HEAD is reachable from a current remote ref', async() => {
    const repository = candidate('detached', {
      detached:      true,
      currentBranch: null,
      localBranches: [],
      headSha:       SHA,
    }).repository;
    await expect(proveGitHubReachabilityWithOctokit(repository, octokit({
      tags: [{ ref: 'refs/tags/release', sha: SHA }],
    }))).resolves.toMatchObject({ status: 'verified' });
  });

  it('fails closed when current refs cannot be read', async() => {
    const unavailable = octokit({ heads: [] });
    unavailable.paginate.mockRejectedValue(new Error('authentication denied'));
    expect(await proveGitHubReachabilityWithOctokit(candidate('auth').repository, unavailable)).toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('authentication denied'),
    });
  });
});

describe('StorageCleanupService plans and receipts', () => {
  it('deduplicates selections and cancellation performs no removal', async() => {
    const item = candidate('dedupe');
    const { service, removeGuest } = harness([item]);
    const inventory = await service.inventory();
    const plan = await service.plan({ targetIds: [inventory.targets[0].id, inventory.targets[0].id] });
    expect(plan.targets).toHaveLength(1);
    expect(plan.estimatedRecoverableBytes).toBe(4096);
    const receipt = await service.cancel(plan.id);
    expect(receipt).toMatchObject({ status: 'cancelled', removedBytes: 0 });
    expect(removeGuest).not.toHaveBeenCalled();
  });

  it('hands an agent-prepared preview to the human screen exactly once', async() => {
    const item = candidate('prepared');
    const { service } = harness([item]);
    const inventory = await service.inventory();
    const prepared = await service.preparePreview({ targetIds: [inventory.targets[0].id] });
    expect(service.takePreparedPreview()).toEqual(prepared);
    expect(service.takePreparedPreview()).toBeUndefined();
  });

  it('blocks a launch that starts after preview during the fresh execution recheck', async() => {
    const item = candidate('raced');
    const { service, setJobs, removeGuest } = harness([item]);
    const inventory = await service.inventory();
    const plan = await service.plan({ targetIds: [inventory.targets[0].id] });
    setJobs([jobFor(item.path, 'running', 'queued')]);
    const receipt = await service.execute(plan.id);
    expect(receipt.status).toBe('failed');
    expect(receipt.targets[0]).toMatchObject({ status: 'blocked' });
    expect(removeGuest).not.toHaveBeenCalled();
  });

  it('executes once, records guest versus host accounting, and replays without a second removal', async() => {
    const item = candidate('once');
    const { service, removeGuest } = harness([item]);
    const inventory = await service.inventory();
    const plan = await service.plan({ targetIds: [inventory.targets[0].id] });
    const first = await service.execute(plan.id);
    const replay = await service.execute(plan.id);
    expect(first).toMatchObject({ status: 'completed', removedBytes: 4096, guestFreeSpaceDeltaBytes: 4096, hostRecovery: { status: 'not-measured' } });
    expect(replay.replayed).toBe(true);
    expect(removeGuest).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent confirmation replays into one removal', async() => {
    const item = candidate('concurrent');
    const { service, removeGuest } = harness([item]);
    const inventory = await service.inventory();
    const plan = await service.plan({ targetIds: [inventory.targets[0].id] });
    const [first, replay] = await Promise.all([service.execute(plan.id), service.execute(plan.id)]);
    expect(first.status).toBe('completed');
    expect(replay).toMatchObject({ status: 'completed', replayed: true });
    expect(removeGuest).toHaveBeenCalledTimes(1);
  });

  it('expires plans and returns an honest interrupted receipt without retrying deletion', async() => {
    const item = candidate('expired');
    const expired = harness([item]);
    const inventory = await expired.service.inventory();
    const plan = await expired.service.plan({ targetIds: [inventory.targets[0].id] });
    expired.advance(5 * 60_000);
    expect((await expired.service.execute(plan.id)).status).toBe('expired');
    expect(expired.removeGuest).not.toHaveBeenCalled();

    const interrupted = harness([item]);
    const inventory2 = await interrupted.service.inventory();
    const plan2 = await interrupted.service.plan({ targetIds: [inventory2.targets[0].id] });
    const partial:StorageCleanupReceipt = {
      operationId:              'old-operation',
      planId:                   plan2.id,
      status:                   'executing',
      startedAt:                '2026-11-17T11:00:00.000Z',
      targets:                  [{ id: inventory2.targets[0].id, path: item.path, status: 'pending', removedBytes: 0, guestFreeSpaceDeltaBytes: null }],
      removedBytes:             0,
      guestFreeSpaceDeltaBytes: 0,
      hostRecovery:             { status: 'not-measured', note: 'pending' },
    };
    await interrupted.receipts.save(partial);
    expect(await interrupted.service.execute(plan2.id)).toMatchObject({ status: 'interrupted', replayed: true });
    expect(interrupted.removeGuest).not.toHaveBeenCalled();
  });
});

describe('StorageCleanupService review regressions', () => {
  it('protects a recovery workspace recorded only in the job results receipt', async() => {
    const item = candidate('job-result-recovery');
    const job = jobFor(item.path);
    job.results = [{
      label:          'work',
      status:         'error',
      output:         'failed',
      threadId:       'child-1',
      cleanupReceipt: { removedGuestPaths: [], retainedGuestPaths: [item.path], recoveryWorkspacePath: item.path, workspaceDecisionReason: 'retained' },
    }];
    const { service } = harness([item], { jobs: [job] });
    expect((await service.inventory()).targets[0]).toMatchObject({ assessment: 'protected', reasonCode: 'recovery-owner', selectable: false });
  });

  it('keeps ownership readable when an in-progress job has a null result slot before a valid receipt', async() => {
    const active = candidate('null-slot-active');
    const paused = candidate('null-slot-paused');
    const recovery = candidate('null-slot-recovery');
    const retained = candidate('null-slot-retained');
    const inactive = candidate('null-slot-inactive');
    const activeJob = jobFor(active.path, 'running', 'queued');
    const pausedJob = jobFor(paused.path, 'parked', 'parked');
    const recoveryJob = jobFor(recovery.path, 'running', 'completed');
    const inactiveJob = jobFor(inactive.path);
    activeJob.results = [null as any];
    pausedJob.results = [null as any];
    inactiveJob.results = [null as any];
    recoveryJob.results = [null as any, {
      label:          'work',
      status:         'error',
      output:         'failed',
      threadId:       'child-1',
      cleanupReceipt: { removedGuestPaths: [], retainedGuestPaths: [retained.path], recoveryWorkspacePath: recovery.path, workspaceDecisionReason: 'retained' },
    }];
    const { service } = harness([active, paused, recovery, retained, inactive], { jobs: [activeJob, pausedJob, recoveryJob, inactiveJob] });
    const inventory = await service.inventory();
    const target = (path:string) => inventory.targets.find(item => item.path === path);
    expect(inventory.targets.some(item => item.reasonCode === 'authority-unavailable')).toBe(false);
    expect(target(active.path)).toMatchObject({ assessment: 'protected', reasonCode: 'active-owner', selectable: false });
    expect(target(paused.path)).toMatchObject({ assessment: 'protected', reasonCode: 'active-owner', selectable: false });
    expect(target(recovery.path)).toMatchObject({ assessment: 'protected', reasonCode: 'recovery-owner', selectable: false });
    expect(target(retained.path)).toMatchObject({ assessment: 'protected', reasonCode: 'recovery-owner', selectable: false });
    expect(target(inactive.path)).toMatchObject({ assessment: 'eligible', selectable: true });
  });

  it('retains replacement or non-commit refs and proves commits held only by non-branch refs', async() => {
    const unsupported = candidate('replace-ref', { unsupportedRefs: ['refs/replace/abc'] });
    const extra = candidate('extra-ref', { extraRefs: [{ name: 'refs/keep/saved', commitSha: SHA_TWO }] });
    const proved:string[][] = [];
    const { service } = harness([unsupported, extra], {
      prove: repository => {
        proved.push([...repository.localBranches.map(ref => ref.commitSha), ...repository.extraRefs.map(ref => ref.commitSha)]);
        return Promise.resolve(verified(repository));
      },
    });
    const inventory = await service.inventory();
    expect(inventory.targets.find(target => target.path === unsupported.path)).toMatchObject({ reasonCode: 'unsupported-refs', selectable: false });
    expect(proved).toEqual([[SHA, SHA_TWO]]);
    const result = await proveGitHubReachabilityWithOctokit(extra.repository, {
      paginate: vi.fn((_method, input:{ ref: string }) => Promise.resolve(input.ref === 'heads/' ? [{ ref: 'refs/heads/feature', object: { type: 'commit', sha: SHA } }] : [])),
      rest:     { git: { listMatchingRefs: vi.fn(), getTag: vi.fn() }, repos: { compareCommits: vi.fn(() => Promise.resolve({ data: { status: 'diverged' } })) } },
    });
    expect(result).toMatchObject({ status: 'unknown', reason: expect.stringContaining(SHA_TWO.slice(0, 12)) });
  });

  it('estimates recovery from recoverable bytes while reporting allocated usage honestly', async() => {
    const item = candidate('hardlinked', {}, { allocatedBytes: 8192, recoverableBytes: 4096 });
    const { service } = harness([item]);
    const inventory = await service.inventory();
    expect(inventory).toMatchObject({ allocatedBytes: 8192, eligibleBytes: 4096 });
    expect((await service.plan({ targetIds: [inventory.targets[0].id] })).estimatedRecoverableBytes).toBe(4096);
  });

  it('labels a partial total instead of hiding measured usage when one workspace is unmeasured', async() => {
    const { service } = harness([candidate('measured'), candidate('unmeasured', {}, { allocatedBytes: null, recoverableBytes: null, scanError: 'timed out' })]);
    expect(await service.inventory()).toMatchObject({ allocatedBytes: null, measuredAllocatedBytes: 4096, unmeasuredCount: 1 });
  });

  it('revalidates only the planned target with a fresh proof and names what changed since review', async() => {
    const item = candidate('changed');
    const { service, dependencies, removeGuest, setCandidates } = harness([item]);
    const inventory = await service.inventory();
    const plan = await service.plan({ targetIds: [inventory.targets[0].id] });
    const scans = vi.mocked(dependencies.scanGuest).mock.calls.length;
    setCandidates([candidate('changed', { fingerprint: 'git-moved' })]);
    const receipt = await service.execute(plan.id);
    expect(vi.mocked(dependencies.scanGuest).mock.calls.length).toBe(scans);
    expect(dependencies.inspectGuest).toHaveBeenCalledWith(expect.objectContaining({ path: item.path }));
    expect(receipt.targets[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('Git refs, history or working tree changed') });
    expect(removeGuest).not.toHaveBeenCalled();
  });

  it('still removes when only the current remote evidence advanced and the fresh proof verifies', async() => {
    const item = candidate('remote-advanced');
    let remoteSha = SHA;
    const { service, removeGuest } = harness([item], {
      prove: repository => Promise.resolve({ status: 'verified', evidence: [{ repository: 'merchant/repo', localCommitSha: repository.headSha!, remoteRef: 'refs/heads/main', remoteCommitSha: remoteSha }] }),
    });
    const inventory = await service.inventory();
    const plan = await service.plan({ targetIds: [inventory.targets[0].id] });
    remoteSha = SHA_THREE;
    expect(await service.execute(plan.id)).toMatchObject({ status: 'completed' });
    expect(removeGuest).toHaveBeenCalledTimes(1);
  });

  it('never lets a cancel overwrite or race an execution receipt', async() => {
    const item = candidate('cancel-after');
    const { service, receipts, removeGuest } = harness([item]);
    const inventory = await service.inventory();
    const plan = await service.plan({ targetIds: [inventory.targets[0].id] });
    const [executed, cancelled] = await Promise.all([service.execute(plan.id), service.cancel(plan.id)]);
    expect(executed.status).toBe('completed');
    expect(cancelled).toMatchObject({ status: 'completed', replayed: true });
    expect(await service.cancel(plan.id)).toMatchObject({ status: 'completed', replayed: true });
    expect((await receipts.get(plan.id))?.status).toBe('completed');
    expect(removeGuest).toHaveBeenCalledTimes(1);
  });

  it('sanitizes guest removal reasons before persisting or returning a receipt', async() => {
    const item = candidate('sanitized');
    const marker = 'removal-secret-must-not-leak';
    const { service, receipts, removeGuest } = harness([item]);
    removeGuest.mockResolvedValueOnce({ status: 'failed', reason: `git: https://user:${ marker }@github.com/x/y.git?token=${ marker }`, removedBytes: 0, guestFreeSpaceDeltaBytes: null });
    const inventory = await service.inventory();
    const plan = await service.plan({ targetIds: [inventory.targets[0].id] });
    const receipt = await service.execute(plan.id);
    expect(JSON.stringify(receipt)).not.toContain(marker);
    expect(JSON.stringify(await receipts.get(plan.id))).not.toContain(marker);
  });

  it('retains a checkout whose only unpublished code is a local Git hook', async() => {
    const { service } = harness([candidate('hooked', { localScripts: ['hooks/pre-commit'] })]);
    expect((await service.inventory()).targets[0]).toMatchObject({ assessment: 'blocked', reasonCode: 'local-git-scripts', selectable: false });
  });

  it('records a partial removal truthfully in the persisted receipt', async() => {
    const item = candidate('partial');
    const { service, receipts, removeGuest } = harness([item]);
    removeGuest.mockResolvedValueOnce({
      status:                   'partial',
      reason:                   `Removal stopped after 3 entries were removed; the remaining files and repository metadata were retained at ${ item.path }: Permission denied`,
      removedBytes:             1024,
      removedEntries:           3,
      guestFreeSpaceDeltaBytes: 512,
    });
    const inventory = await service.inventory();
    const plan = await service.plan({ targetIds: [inventory.targets[0].id] });
    const receipt = await service.execute(plan.id);
    expect(receipt).toMatchObject({ status: 'partial', removedBytes: 1024, guestFreeSpaceDeltaBytes: 512 });
    expect(receipt.targets[0]).toMatchObject({ status: 'partial', path: item.path, reason: expect.stringContaining('retained at') });
    expect(await receipts.get(plan.id)).toMatchObject({ status: 'partial', targets: [expect.objectContaining({ status: 'partial' })] });
    expect(await service.execute(plan.id)).toMatchObject({ status: 'partial', replayed: true });
    expect(removeGuest).toHaveBeenCalledTimes(1);
  });
});
