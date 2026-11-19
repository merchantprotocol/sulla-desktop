// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FilesSection from '@pkg/components/settings/sections/FilesSection.vue';
import type {
  StorageCleanupInventory,
  StorageCleanupPlan,
  StorageCleanupReceipt,
} from '@pkg/main/storageCleanup/StorageCleanupService';
import { formatStorageMegabytes } from '@pkg/shared/storageCleanupUnits';

// Separators come from the runtime locale so expectations hold outside en-US.
const DECIMAL = (0.5).toLocaleString().replace(/\d/g, '');
const GROUP = (1000).toLocaleString().replace(/\d/g, '');
const MINUS = (-1).toLocaleString().replace(/\d/g, '');
const mb = (whole:string, fraction?:string) => `${ whole }${ fraction ? `${ DECIMAL }${ fraction }` : '' } MB`;
const RAW_UNITS = /\d ?(B|KB|GB|bytes)\b/;

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: { invoke, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

const target = {
  id:                        'target-1',
  displayName:               'merchant/repo · feature',
  repositoryName:            'merchant/repo',
  branchLabel:               'feature',
  path:                      '/mnt/data/sulla/runtime/conversations/abc/workspace/repo',
  workspaceRoot:             '/mnt/data/sulla/runtime/conversations/abc/workspace',
  source:                    'conversation-child' as const,
  location:                  'Sulla VM' as const,
  allocatedBytes:            8192,
  recoverableBytes:          8192,
  estimatedRecoverableBytes: 8192,
  lastActivityAt:            '2026-11-01T00:00:00.000Z',
  measurement:               'measured' as const,
  assessment:                'eligible' as const,
  reasonCode:                'remote-verified-inactive',
  reason:                    'Inactive code is fully represented by current GitHub branch or tag refs.',
  selectable:                true,
  associations:              [
    { kind: 'chat' as const, id: 'chat-1', label: 'Cleanup chat' },
    { kind: 'project' as const, id: 'files:home:Alpha', label: 'Alpha' },
  ],
  identity:                  { realPath: '/mnt/data/sulla/runtime/conversations/abc/workspace/repo', device: 1, inode: 2, mode: 16832, size: 64, modifiedNanoseconds: '1', contentFingerprint: 'content' },
  repository:                {
    headSha:            '1'.repeat(40),
    detached:           false,
    currentBranch:      'feature',
    localBranches:      [{ name: 'feature', commitSha: '1'.repeat(40) }],
    localTags:          [],
    extraRefs:          [],
    unsupportedRefs:    [],
    localScripts:       [],
    refsDigest:         'refs',
    reflogCommits:      ['1'.repeat(40)],
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
    fingerprint:        'git',
  },
  remoteEvidence: [{ repository: 'merchant/repo', localCommitSha: '1'.repeat(40), remoteRef: 'refs/heads/feature', remoteCommitSha: '1'.repeat(40) }],
  revision:       'revision-1',
};

const inventory:StorageCleanupInventory = {
  generatedAt:        '2026-11-17T12:00:00.000Z',
  status:             'ready',
  targets:            [target],
  projects:           [{ id: 'files:home:Alpha', label: 'Alpha', path: 'Projects/Alpha', projectFileId: 'project-file-1', collectionId: 'home' }],
  allocatedBytes:         8192,
  measuredAllocatedBytes: 8192,
  unmeasuredCount:        0,
  eligibleBytes:          8192,
  scanErrors:         [],
  authorityAvailable: true,
  runtimeAvailable:   true,
  accounting:         { guest: 'Measured in VM.', host: 'Host recovery is measured separately.' },
};

const plan:StorageCleanupPlan = {
  id:                'plan-1',
  createdAt:         '2026-11-17T12:00:00.000Z',
  expiresAt:         '2026-11-17T12:05:00.000Z',
  selectedTargetIds: [target.id],
  targets:           [{
    id:             target.id,
    displayName:    target.displayName,
    path:           target.path,
    workspaceRoot:  target.workspaceRoot,
    source:         target.source,
    allocatedBytes:   8192,
    recoverableBytes: 8192,
    revision:         target.revision,
    identity:         target.identity,
    gitFingerprint:   target.repository.fingerprint,
    ownership:        'ownership',
    remoteEvidence:   target.remoteEvidence,
  }],
  blocked:                   [{ id: 'blocked-1', displayName: 'merchant/retained · local', path: '/mnt/data/sulla/runtime/agents/retained', reason: 'Ignored files are retained.' }],
  estimatedRecoverableBytes: 8192,
};

const receipt:StorageCleanupReceipt = {
  operationId:              'operation-1',
  planId:                   plan.id,
  status:                   'completed',
  startedAt:                '2026-11-17T12:00:01.000Z',
  finishedAt:               '2026-11-17T12:00:02.000Z',
  targets:                  [{ id: target.id, path: target.path, status: 'removed', removedBytes: 8192, guestFreeSpaceDeltaBytes: 4096 }],
  removedBytes:             8192,
  guestFreeSpaceDeltaBytes: 4096,
  hostRecovery:             { status: 'not-measured', note: 'Guest deletion does not prove immediate host recovery.' },
};

let wrapper:VueWrapper | undefined;

beforeEach(() => {
  invoke.mockImplementation((channel:string) => {
    if (channel === 'files-preferences:list-roots') return Promise.resolve([]);
    if (channel === 'files-backups:list') return Promise.resolve({ destinations: [] });
    if (channel === 'files-preferences:file-provider-status') return Promise.resolve({ supported: false, enabled: false, running: false, helperPresent: false });
    if (channel === 'files-storage-cleanup:inventory') return Promise.resolve(inventory);
    if (channel === 'files-storage-cleanup:prepared-plan') return Promise.resolve(undefined);
    if (channel === 'files-storage-cleanup:plan') return Promise.resolve(plan);
    if (channel === 'files-storage-cleanup:confirm') return Promise.resolve(receipt);
    return Promise.reject(new Error(`Unexpected IPC channel: ${ channel }`));
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  invoke.mockReset();
});

describe('Files storage cleanup review flow', () => {
  it('shows each target\'s partial or failed outcome with its exact path and reason', async() => {
    const fallback = invoke.getMockImplementation()!;
    const partialReason = `Removal stopped after 3 entries were removed; the remaining files and repository metadata were retained at ${ target.path }: Permission denied`;
    invoke.mockImplementation((channel:string, ...args:unknown[]) => {
      if (channel === 'files-storage-cleanup:confirm') {
        return Promise.resolve({
          ...receipt,
          status:       'partial',
          removedBytes: 1024,
          targets:      [{ id: target.id, path: target.path, status: 'partial', reason: partialReason, removedBytes: 1024, guestFreeSpaceDeltaBytes: 512 }],
        });
      }
      return fallback(channel, ...args);
    });
    wrapper = mount(FilesSection, { attachTo: document.body });
    await flushPromises();
    await wrapper.get(`input[aria-label="Select ${ target.path }"]`).setValue(true);
    await wrapper.findAll('button').find(button => button.text().startsWith('Review'))!.trigger('click');
    await flushPromises();
    await wrapper.get('[aria-label="Cleanup review"] .danger').trigger('click');
    await flushPromises();
    const results = wrapper.get('[aria-label="Cleanup results by workspace"]').text();
    expect(wrapper.get('[role="status"]').text()).toContain('Cleanup partial');
    expect(results).toContain(`partial · ${ mb('0', '001') } removed`);
    expect(results).toContain(target.path);
    expect(results).toContain(partialReason);
  });

  it('labels a partial VM total with its unmeasured workspace count', async() => {
    const fallback = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel:string, ...args:unknown[]) => channel === 'files-storage-cleanup:inventory'
      ? Promise.resolve({ ...inventory, allocatedBytes: null, measuredAllocatedBytes: 8192, unmeasuredCount: 2 })
      : fallback(channel, ...args));
    wrapper = mount(FilesSection, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.text()).toContain(`${ mb('0', '008') }+`);
    expect(wrapper.text()).toContain('2 unmeasured');
  });

  it('opens an agent-prepared preview on the same human review screen', async() => {
    const fallback = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel:string, ...args:unknown[]) => channel === 'files-storage-cleanup:prepared-plan'
      ? Promise.resolve(plan)
      : fallback(channel, ...args));
    wrapper = mount(FilesSection, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[aria-label="Cleanup review"]').text()).toContain(target.displayName);
    expect(wrapper.get('[aria-label="Cleanup review"]').text()).toContain(target.path);
    expect(wrapper.get('[aria-label="Cleanup review"]').text()).toContain(`${ mb('0', '008') } estimated guest recovery`);
    expect(wrapper.get('[aria-label="Cleanup review"]').text()).not.toMatch(RAW_UNITS);
  });

  it('selects, reviews, cancels without confirmation, then confirms through the main-process seam', async() => {
    wrapper = mount(FilesSection, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.text()).toContain(`${ mb('0', '008') }Allocated in VM`);
    expect(wrapper.text()).toContain(`${ mb('0', '008') }Eligible estimate`);
    expect(wrapper.text()).toContain(`${ mb('0', '008') } allocated`);
    expect(wrapper.text()).toContain('Alpha');
    expect(wrapper.text()).toContain('1Files projects');
    expect(wrapper.text()).toContain('Cleanup chat');
    expect(wrapper.text()).toContain('merchant/repo · feature');

    await wrapper.get(`input[aria-label="Select ${ target.path }"]`).setValue(true);
    const review = wrapper.findAll('button').find(button => button.text().startsWith('Review'))!;
    await review.trigger('click');
    await flushPromises();
    expect(wrapper.get('[aria-label="Cleanup review"]').text()).toContain('Review 1 workspace');
    expect(wrapper.get('[aria-label="Cleanup review"]').text()).toContain(target.path);
    expect(wrapper.get('[aria-label="Cleanup review"]').text()).toContain('Ignored files are retained.');

    await wrapper.get('[aria-label="Cleanup review"] .ghost').trigger('click');
    expect(wrapper.find('[aria-label="Cleanup review"]').exists()).toBe(false);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'files-storage-cleanup:confirm')).toHaveLength(0);

    await review.trigger('click');
    await flushPromises();
    await wrapper.get('[aria-label="Cleanup review"] .danger').trigger('click');
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith('files-storage-cleanup:confirm', { planId: plan.id });
    expect(wrapper.get('[role="status"]').text()).toContain('Cleanup completed');
    expect(wrapper.get('[role="status"]').text()).toContain('Guest deletion does not prove immediate host recovery.');
    const outcome = wrapper.get('[role="status"]').text();
    expect(outcome).toContain(`${ mb('0', '008') } removed from selected guest paths.`);
    expect(outcome).toContain(`${ mb('0', '004') } measured VM free-space change.`);
    expect(outcome).toContain(`removed · ${ mb('0', '008') } removed`);
    expect(outcome).not.toMatch(RAW_UNITS);
  });
});

describe('storage cleanup decimal megabyte formatter', () => {
  it('reports cleanup sizes in decimal MB, where 1 MB is 1,000,000 bytes', () => {
    expect(formatStorageMegabytes(192_512)).toBe(mb('0', '193'));
    expect(formatStorageMegabytes(4096)).toBe(mb('0', '004'));
    expect(formatStorageMegabytes(1_000_000)).toBe(mb('1'));
    expect(formatStorageMegabytes(1_234_567_890)).toBe(`1${ GROUP }${ mb('234', '568') }`);
  });

  it('never shows a nonzero amount as 0 MB', () => {
    expect(formatStorageMegabytes(1)).toBe(mb('0', '000001'));
    expect(formatStorageMegabytes(999)).toBe(mb('0', '000999'));
    expect(formatStorageMegabytes(1000)).toBe(mb('0', '001'));
    expect(formatStorageMegabytes(0)).toBe('0 MB');
  });

  it('keeps the sign of a negative free-space change and marks missing measurements unavailable', () => {
    expect(formatStorageMegabytes(-4096)).toBe(`${ MINUS }${ mb('0', '004') }`);
    expect(formatStorageMegabytes(-12)).toBe(`${ MINUS }${ mb('0', '000012') }`);
    for (const missing of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatStorageMegabytes(missing)).toBe('Unavailable');
    }
  });
});
