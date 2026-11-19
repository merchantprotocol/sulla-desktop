<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

import PrefCard from '../PrefCard.vue';
import PrefIcon from '../PrefIcon.vue';
import PrefMore from '../PrefMore.vue';
import PrefRow from '../PrefRow.vue';
import PrefToggle from '../PrefToggle.vue';

import type {
  StorageCleanupInventory,
  StorageCleanupPlan,
  StorageCleanupReceipt,
  StorageCleanupTarget,
} from '@pkg/main/storageCleanup/StorageCleanupService';
import { formatStorageMegabytes } from '@pkg/shared/storageCleanupUnits';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface FileRoot {
  id:            string;
  name:          string;
  path:          string;
  syncMode:      'local' | 'server';
  paused:        boolean;
  exclusions:    string[];
  state?:        'idle' | 'scanning' | 'syncing' | 'paused' | 'offline' | 'error' | 'detached';
  pendingFiles?: number;
  lastError?:    string;
  lastSyncAt?:   string;
  activation:    'active' | 'pending-restart' | 'offline';
  removable:     boolean;
}
interface FileProvider {
  supported:     boolean;
  enabled:       boolean;
  running:       boolean;
  helperPresent: boolean;
  registered?:   boolean;
  error?:        string;
}
interface Backup {
  id:      string;
  kind:    'local' | 'nas' | 's3';
  label:   string;
  status?: { state: 'running' | 'verified' | 'failed', finished_at?: string, error_message?: string };
}

const roots = ref<FileRoot[]>([]);
const backups = ref<Backup[]>([]);
const finder = ref<FileProvider>();
const finderSaving = ref(false);
const busy = reactive(new Set<string>());
const error = ref('');
const adding = ref(false);
const storageInventory = ref<StorageCleanupInventory>();
const storageLoading = ref(false);
const storageView = ref<'project' | 'chat'>('project');
const storageSelected = ref(new Set<string>());
const storageExpanded = ref(new Set<string>());
const storagePlan = ref<StorageCleanupPlan>();
const storageOutcome = ref<StorageCleanupReceipt>();
const storageError = ref('');
const EMPTY_DRAFT = {
  label:        '',
  subfolder:    '',
  share:        '',
  endpoint:     '',
  bucket:       '',
  region:       '',
  credentialId: '',
};
const draft = reactive({
  ...EMPTY_DRAFT,
  kind:     'local' as 'local' | 'nas' | 's3',
  protocol: 'smb' as 'smb' | 'nfs',
});
let rootPoll: ReturnType<typeof setInterval> | undefined;
let backupPoll: ReturnType<typeof setInterval> | undefined;

function fail(err: unknown) {
  error.value = err instanceof Error ? err.message : String(err);
}

async function loadRoots() {
  try {
    roots.value = await ipcRenderer.invoke('files-preferences:list-roots') as FileRoot[];
  } catch (err) {
    fail(err);
  }
}

async function loadBackups() {
  try {
    backups.value = (await ipcRenderer.invoke('files-backups:list')).destinations as Backup[];
  } catch (err) {
    fail(err);
  }
}

async function loadFinder() {
  try {
    finder.value = await ipcRenderer.invoke('files-preferences:file-provider-status') as FileProvider;
  } catch (err) {
    fail(err);
  }
}

function byteSize(value:number | null | undefined) {
  return formatStorageMegabytes(value);
}

async function loadStorage() {
  storageLoading.value = true;
  storageError.value = '';
  storagePlan.value = undefined;
  try {
    storageInventory.value = await ipcRenderer.invoke('files-storage-cleanup:inventory');
    storagePlan.value = await ipcRenderer.invoke('files-storage-cleanup:prepared-plan');
    const present = new Set(storageInventory.value.targets.filter(target => target.selectable).map(target => target.id));
    storageSelected.value = new Set([...storageSelected.value].filter(id => present.has(id)));
  } catch (err) {
    storageError.value = err instanceof Error ? err.message : String(err);
  } finally {
    storageLoading.value = false;
  }
}

function loadPreparedStoragePreview() {
  if (!storageLoading.value) loadStorage().catch(err => { storageError.value = err instanceof Error ? err.message : String(err) });
}

function storageAssociation(target:StorageCleanupTarget) {
  const matches = target.associations.filter(item => item.kind === storageView.value);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { id: 'multiple', label: `Multiple ${ storageView.value === 'project' ? 'projects' : 'chats' }` };
  return { id: 'unknown', label: storageView.value === 'project' ? 'Unlinked project' : 'Unknown chat' };
}

const storageGroups = computed(() => {
  const groups = new Map<string, { id:string; label:string; targets:StorageCleanupTarget[] }>();
  if (storageView.value === 'project') {
    for (const project of storageInventory.value?.projects ?? []) {
      const key = `project:${ project.id }`;
      groups.set(key, { id: key, label: project.label, targets: [] });
    }
  }
  for (const target of storageInventory.value?.targets ?? []) {
    const association = storageAssociation(target);
    const key = `${ storageView.value }:${ association.id }`;
    const group = groups.get(key) ?? { id: key, label: association.label, targets: [] };
    group.targets.push(target);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
});

function storageRowContext(target:StorageCleanupTarget) {
  const kind = storageView.value === 'project' ? 'chat' : 'project';
  const labels = target.associations.filter(item => item.kind === kind).map(item => item.label);
  if (!labels.length) return kind === 'chat' ? 'Unknown chat' : 'Unlinked project';
  return labels.join(', ');
}

function groupBytes(targets:StorageCleanupTarget[], eligible = false) {
  if (eligible) return targets.reduce((sum, target) => sum + (target.selectable ? target.recoverableBytes ?? 0 : 0), 0);
  if (targets.some(target => target.allocatedBytes === null)) return null;
  return targets.reduce((sum, target) => sum + (target.allocatedBytes ?? 0), 0);
}

/** A partial total is labelled with its unmeasured count, never shown as complete. */
const storageAllocatedLabel = computed(() => {
  const inventory = storageInventory.value;
  if (!inventory) return { bytes: byteSize(undefined), note: 'Allocated in VM' };
  if (inventory.allocatedBytes !== null || !inventory.unmeasuredCount) return { bytes: byteSize(inventory.allocatedBytes), note: 'Allocated in VM' };
  return { bytes: `${ byteSize(inventory.measuredAllocatedBytes) }+`, note: `Allocated in VM · ${ inventory.unmeasuredCount } unmeasured` };
});

function toggleStorageTarget(id:string) {
  const next = new Set(storageSelected.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  storageSelected.value = next;
  storagePlan.value = undefined;
}

function toggleStorageDetails(id:string) {
  const next = new Set(storageExpanded.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  storageExpanded.value = next;
}

async function reviewStorage() {
  storageError.value = '';
  storageOutcome.value = undefined;
  try {
    storagePlan.value = await ipcRenderer.invoke('files-storage-cleanup:plan', {
      targetIds: [...storageSelected.value],
    });
  } catch (err) {
    storageError.value = err instanceof Error ? err.message : String(err);
  }
}

async function confirmStorage() {
  if (!storagePlan.value) return;
  storageLoading.value = true;
  storageError.value = '';
  try {
    storageOutcome.value = await ipcRenderer.invoke('files-storage-cleanup:confirm', {
      planId: storagePlan.value.id,
    });
    storagePlan.value = undefined;
    storageSelected.value = new Set();
    await loadStorage();
  } catch (err) {
    storageError.value = err instanceof Error ? err.message : String(err);
  } finally {
    storageLoading.value = false;
  }
}

async function guarded(id: string, work: () => Promise<unknown>) {
  busy.add(id);
  error.value = '';
  try {
    await work();
  } catch (err) {
    fail(err);
  } finally {
    busy.delete(id);
  }
}

async function addRoot() {
  error.value = '';
  try {
    const root = await ipcRenderer.invoke('files-preferences:add-root') as FileRoot | undefined;

    if (root) {
      roots.value.push(root);
    }
  } catch (err) {
    fail(err);
  }
}

function update(root: FileRoot, changes: Partial<Pick<FileRoot, 'paused' | 'syncMode' | 'exclusions'>>) {
  return guarded(root.id, async() => {
    Object.assign(root, await ipcRenderer.invoke('files-preferences:update-root', { id: root.id, ...changes }));
  });
}

function setSyncMode(root: FileRoot, event: Event) {
  return update(root, { syncMode: (event.target as HTMLSelectElement).value === 'server' ? 'server' : 'local' });
}

function saveExclusions(root: FileRoot, event: Event) {
  const list = (event.target as HTMLTextAreaElement).value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);

  return update(root, { exclusions: list });
}

async function stopTracking(root: FileRoot) {
  const result = await ipcRenderer.invoke('show-message-box', {
    type:     'warning',
    title:    'Stop tracking folder?',
    message:  `Stop tracking ${ root.name }?`,
    detail:   'The folder and its files stay where they are. Versions already saved stay in Sulla Files.',
    buttons:  ['Stop tracking', 'Cancel'],
    cancelId: 1,
  });

  if (result.response !== 0) {
    return;
  }
  await guarded(root.id, async() => {
    await ipcRenderer.invoke('files-preferences:remove-root', root.id);
    roots.value = roots.value.filter(item => item.id !== root.id);
  });
}

function ago(iso?: string) {
  if (!iso) {
    return '';
  }
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);

  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${ minutes } min ago`;
  }
  const hours = Math.round(minutes / 60);

  return hours < 48 ? `${ hours } hours ago` : new Date(iso).toLocaleDateString();
}

function rootStatus(root: FileRoot) {
  if (root.activation === 'pending-restart') {
    return 'Ready after Sulla restarts';
  }
  if (root.activation === 'offline') {
    return 'Files service offline';
  }
  if (root.paused) {
    return 'Paused';
  }
  const pending = root.pendingFiles ? ` · ${ root.pendingFiles } pending` : '';

  if (root.state === 'scanning' || root.state === 'syncing') {
    return `${ root.state === 'scanning' ? 'Scanning' : 'Syncing' }${ pending }`;
  }
  if (root.state === 'error') {
    return root.lastError || 'Error';
  }

  return root.lastSyncAt ? `Synced ${ ago(root.lastSyncAt) }${ pending }` : `Not synced yet${ pending }`;
}

function rootDot(root: FileRoot) {
  if (root.state === 'error' || root.activation === 'offline') {
    return 'bad';
  }
  if (root.paused || root.activation === 'pending-restart') {
    return 'off';
  }

  return root.pendingFiles ? 'warn' : '';
}

async function setFinder(enabled: boolean) {
  finderSaving.value = true;
  error.value = '';
  try {
    finder.value = await ipcRenderer.invoke('files-preferences:set-file-provider', { enabled }) as FileProvider;
  } catch (err) {
    fail(err);
  } finally {
    finderSaving.value = false;
  }
}

function backupLine(backup: Backup) {
  const kind = { local: 'This Mac', nas: 'NAS', s3: 'S3' }[backup.kind];
  const status = backup.status;

  if (!status) {
    return `${ kind } · not run yet`;
  }
  if (status.state === 'running') {
    return `${ kind } · backing up now`;
  }
  if (status.state === 'failed') {
    return `${ kind } · last backup failed${ status.error_message ? `: ${ status.error_message }` : '' }`;
  }

  return `${ kind } · last verified backup ${ ago(status.finished_at) }`;
}

function backupDot(backup: Backup) {
  return { verified: '', running: 'warn', failed: 'bad' }[backup.status?.state ?? 'none'] ?? 'off';
}

function runBackup(backup: Backup) {
  return guarded(backup.id, async() => {
    await ipcRenderer.invoke('files-backups:run', backup.id);
    await loadBackups();
  });
}

async function removeBackup(backup: Backup) {
  const result = await ipcRenderer.invoke('show-message-box', {
    type:     'warning',
    title:    'Remove backup destination?',
    message:  `Remove ${ backup.label }?`,
    detail:   'Sulla stops backing up there. Backups already made are kept.',
    buttons:  ['Remove', 'Cancel'],
    cancelId: 1,
  });

  if (result.response === 0) {
    await guarded(backup.id, async() => {
      await ipcRenderer.invoke('files-backups:remove', backup.id);
      await loadBackups();
    });
  }
}

async function addBackup() {
  let config: Record<string, unknown>;

  if (draft.kind === 'local') {
    config = { kind: 'local', root: `/var/lib/sulla-files-backups/${ draft.subfolder }` };
  } else if (draft.kind === 'nas') {
    config = {
      kind:              'nas',
      share:             draft.share,
      protocol:          draft.protocol,
      vaultCredentialId: draft.credentialId || undefined,
    };
  } else {
    config = {
      kind:              's3',
      endpoint:          draft.endpoint,
      bucket:            draft.bucket,
      region:            draft.region || undefined,
      vaultCredentialId: draft.credentialId,
    };
  }

  await guarded('add-backup', async() => {
    await ipcRenderer.invoke('files-backups:add', { kind: draft.kind, label: draft.label, config });
    Object.assign(draft, EMPTY_DRAFT);
    adding.value = false;
    await loadBackups();
  });
}

onMounted(async() => {
  window.addEventListener('sulla:storage-cleanup-preview', loadPreparedStoragePreview);
  await Promise.all([loadRoots(), loadBackups(), loadFinder(), loadStorage()]);
  rootPoll = setInterval(() => {
    if (roots.value.some(root => root.state === 'scanning' || root.state === 'syncing')) {
      void loadRoots();
    }
  }, 1_000);
  backupPoll = setInterval(() => {
    if (backups.value.some(backup => backup.status?.state === 'running')) {
      void loadBackups();
    }
  }, 3_000);
});

onBeforeUnmount(() => {
  window.removeEventListener('sulla:storage-cleanup-preview', loadPreparedStoragePreview);
  clearInterval(rootPoll);
  clearInterval(backupPoll);
});
</script>

<template>
  <div>
    <div class="ph">
      <div>
        <h1>Files &amp; backups</h1>
        <p>Folders Sulla tracks, Finder access and backups.</p>
      </div>
    </div>

    <PrefCard
      title="Tracked folders"
      subtitle="Sulla never moves or deletes the source when tracking stops."
    >
      <template #actions>
        <button
          type="button"
          class="btn sm pri"
          @click="addRoot"
        >
          <PrefIcon name="plus" />Add folder
        </button>
      </template>
      <div class="set col">
        <div class="lst">
          <div
            v-for="root in roots"
            :key="root.id"
          >
            <span
              class="dot"
              :class="rootDot(root)"
            />
            <span class="grow"><b>{{ root.name }}</b><small class="mono">{{ root.path }}</small></span>
            <span class="r">
              <span :class="{ badc: root.state === 'error' }">{{ rootStatus(root) }}</span>
              <select
                class="sel"
                aria-label="Where this folder is stored"
                :value="root.syncMode"
                :disabled="busy.has(root.id)"
                @change="setSyncMode(root, $event)"
              >
                <option value="local">This Mac only</option>
                <option value="server">Files server</option>
              </select>
              <button
                type="button"
                class="btn sm"
                :disabled="busy.has(root.id)"
                @click="update(root, { paused: !root.paused })"
              >{{ root.paused ? 'Resume' : 'Pause' }}</button>
              <button
                v-if="root.removable"
                type="button"
                class="btn sm danger"
                :disabled="busy.has(root.id)"
                @click="stopTracking(root)"
              >Stop tracking</button>
            </span>
          </div>
          <div
            v-if="!roots.length"
            class="empty-row"
          >
            No folders tracked yet.
          </div>
        </div>
      </div>
      <PrefMore
        v-if="roots.length"
        label="Exclusions"
      >
        <PrefRow
          v-for="root in roots"
          :key="root.id"
          layout="col"
          :title="root.name"
          subtitle="One pattern per line. Matching files aren’t tracked."
        >
          <textarea
            class="ta"
            rows="3"
            :aria-label="`Exclusions for ${ root.name }`"
            :value="root.exclusions.join('\n')"
            :disabled="busy.has(root.id)"
            placeholder=".git/&#10;node_modules/"
            @change="saveExclusions(root, $event)"
          />
        </PrefRow>
      </PrefMore>
    </PrefCard>

    <PrefCard
      v-if="finder?.supported"
      title="Finder"
    >
      <PrefRow
        title="Show Sulla Files in Finder"
        subtitle="Under Locations. Your Documents folder isn’t moved."
      >
        <PrefToggle
          :model-value="finder.enabled"
          :disabled="finderSaving || !finder.helperPresent"
          label="Show Sulla Files in Finder"
          @update:model-value="setFinder"
        />
      </PrefRow>
      <p
        v-if="finder.enabled && finder.registered === false"
        class="note"
      >
        Approve Sulla in System Settings › General › Login Items &amp; Extensions › File Provider.
      </p>
      <p
        v-if="finder.error"
        class="note badc"
      >
        {{ finder.error }}
      </p>
    </PrefCard>

    <PrefCard
      title="Storage &amp; cleanup"
      subtitle="Review inactive code workspaces. Nothing is removed automatically."
    >
      <template #actions>
        <div class="storage-actions">
          <div
            class="storage-segment"
            role="group"
            aria-label="Group storage by"
          >
            <button
              type="button"
              :class="{ on: storageView === 'project' }"
              :aria-pressed="storageView === 'project'"
              @click="storageView = 'project'"
            >Projects</button>
            <button
              type="button"
              :class="{ on: storageView === 'chat' }"
              :aria-pressed="storageView === 'chat'"
              @click="storageView = 'chat'"
            >Chats</button>
          </div>
          <button
            type="button"
            class="btn sm"
            :disabled="storageLoading"
            @click="loadStorage"
          >Refresh</button>
        </div>
      </template>

      <div class="storage-summary" aria-live="polite">
        <span><b>{{ storageAllocatedLabel.bytes }}</b><small>{{ storageAllocatedLabel.note }}</small></span>
        <span><b>{{ byteSize(storageInventory?.eligibleBytes) }}</b><small>Eligible estimate</small></span>
        <span><b>{{ storageView === 'project' ? (storageInventory?.projects.length ?? 0) : (storageInventory?.targets.length ?? 0) }}</b><small>{{ storageView === 'project' ? 'Files projects' : 'Code workspaces' }}</small></span>
      </div>

      <p
        v-if="storageLoading && !storageInventory"
        class="note"
      >Scanning bounded guest workspaces and verifying current GitHub refs…</p>
      <p
        v-if="storageError"
        class="note badc"
        role="alert"
      >{{ storageError }}</p>
      <p
        v-for="scanError in storageInventory?.scanErrors ?? []"
        :key="scanError"
        class="note badc"
        role="alert"
      >{{ scanError }}</p>

      <div
        v-if="storageInventory && !storageInventory.targets.length && !storageLoading"
        class="empty-row"
      >No code workspaces were found in the approved guest roots.</div>

      <div
        v-for="group in storageGroups"
        :key="group.id"
        class="storage-group"
      >
        <div class="storage-group-head">
          <b>{{ group.label }}</b>
          <span>{{ byteSize(groupBytes(group.targets)) }} allocated</span>
          <span>{{ byteSize(groupBytes(group.targets, true)) }} eligible</span>
        </div>
        <div class="storage-table" role="table" :aria-label="`${group.label} storage`">
          <div class="storage-table-head" role="row">
            <span role="columnheader">Select</span>
            <span role="columnheader">Checkout</span>
            <span role="columnheader">Disk used</span>
            <span role="columnheader">Last activity</span>
            <span role="columnheader">Assessment</span>
          </div>
          <template
            v-for="target in group.targets"
            :key="target.id"
          >
            <div class="storage-row" role="row">
              <span role="cell">
                <input
                  type="checkbox"
                  :checked="storageSelected.has(target.id)"
                  :disabled="!target.selectable || storageLoading"
                  :aria-label="`Select ${target.path}`"
                  @change="toggleStorageTarget(target.id)"
                >
              </span>
              <span class="storage-location" role="cell">
                <b>{{ target.displayName }}</b>
                <small>{{ target.location }} · {{ storageRowContext(target) }}</small>
                <button
                  type="button"
                  class="storage-details-button"
                  :aria-expanded="storageExpanded.has(target.id)"
                  @click="toggleStorageDetails(target.id)"
                >{{ storageExpanded.has(target.id) ? 'Hide details' : 'Details' }}</button>
              </span>
              <span role="cell">{{ byteSize(target.allocatedBytes) }}</span>
              <span role="cell">{{ target.lastActivityAt ? ago(target.lastActivityAt) : 'Unknown' }}</span>
              <span role="cell">
                <b class="storage-assessment" :class="target.assessment">{{ target.assessment }}</b>
                <small>{{ target.reason }}</small>
              </span>
            </div>
            <div
              v-if="storageExpanded.has(target.id)"
              class="storage-detail"
              role="row"
            >
              <span class="mono">{{ target.path }}</span>
              <span>{{ target.reasonCode }}</span>
              <span v-if="target.remoteEvidence.length">{{ target.remoteEvidence.length }} local commit proof{{ target.remoteEvidence.length === 1 ? '' : 's' }} on current remote refs</span>
            </div>
          </template>
          <div
            v-if="!group.targets.length"
            class="empty-row"
          >No code workspaces are explicitly linked to this project.</div>
        </div>
      </div>

      <div class="storage-footer">
        <p class="note">
          {{ storageInventory?.accounting.host ?? 'Host recovery is reported separately from guest workspace removal.' }}
        </p>
        <button
          type="button"
          class="btn sm pri"
          :disabled="storageSelected.size === 0 || storageLoading"
          @click="reviewStorage"
        >Review {{ storageSelected.size || '' }}</button>
      </div>

      <div
        v-if="storagePlan"
        class="storage-review"
        role="region"
        aria-label="Cleanup review"
      >
        <div>
          <b>Review {{ storagePlan.targets.length }} workspace{{ storagePlan.targets.length === 1 ? '' : 's' }}</b>
          <small>{{ byteSize(storagePlan.estimatedRecoverableBytes) }} estimated guest recovery. Eligibility is checked again after native confirmation.</small>
        </div>
        <ul class="storage-review-list">
          <li
            v-for="target in storagePlan.targets"
            :key="target.id"
          >
            <b>{{ target.displayName }}</b>
            <span class="mono">{{ target.path }}</span>
          </li>
          <li
            v-for="blocked in storagePlan.blocked"
            :key="`blocked:${blocked.id}`"
            class="blocked"
          >
            <b>{{ blocked.displayName }} · retained</b>
            <span v-if="blocked.path" class="mono">{{ blocked.path }}</span>
            <span>{{ blocked.reason }}</span>
          </li>
        </ul>
        <div class="storage-review-actions">
          <button
            type="button"
            class="btn sm ghost"
            @click="storagePlan = undefined"
          >Cancel</button>
          <button
            type="button"
            class="btn sm danger"
            :disabled="storageLoading"
            @click="confirmStorage"
          >Continue to confirmation</button>
        </div>
      </div>

      <div
        v-if="storageOutcome"
        class="storage-outcome"
        role="status"
      >
        <b>Cleanup {{ storageOutcome.status }}</b>
        <span>{{ byteSize(storageOutcome.removedBytes) }} removed from selected guest paths.</span>
        <span>{{ byteSize(storageOutcome.guestFreeSpaceDeltaBytes) }} measured VM free-space change.</span>
        <span>{{ storageOutcome.hostRecovery.note }}</span>
        <ul
          v-if="storageOutcome.targets.length"
          class="storage-review-list"
          aria-label="Cleanup results by workspace"
        >
          <li
            v-for="item in storageOutcome.targets"
            :key="`outcome:${item.id}`"
            :class="{ blocked: item.status !== 'removed' }"
          >
            <b>{{ item.status }} · {{ byteSize(item.removedBytes) }} removed</b>
            <span class="mono">{{ item.path }}</span>
            <span v-if="item.reason">{{ item.reason }}</span>
          </li>
        </ul>
      </div>
    </PrefCard>

    <PrefCard
      title="Backups"
      subtitle="Hourly for a day, daily for a month, weekly for 12 weeks."
    >
      <template #actions>
        <button
          type="button"
          class="btn sm"
          @click="adding = !adding"
        >
          <PrefIcon name="plus" />Add destination
        </button>
      </template>
      <div class="set col">
        <div class="lst">
          <div
            v-for="backup in backups"
            :key="backup.id"
          >
            <span
              class="dot"
              :class="backupDot(backup)"
            />
            <span class="grow"><b>{{ backup.label }}</b><small>{{ backupLine(backup) }}</small></span>
            <span class="r">
              <button
                type="button"
                class="btn sm"
                :disabled="busy.has(backup.id) || backup.status?.state === 'running'"
                @click="runBackup(backup)"
              >Run now</button>
              <button
                type="button"
                class="btn sm"
                disabled
                title="Restoring needs an empty Files destination"
              >Restore…</button>
              <button
                type="button"
                class="btn sm ghost"
                :disabled="busy.has(backup.id) || backup.status?.state === 'running'"
                @click="removeBackup(backup)"
              >Remove</button>
            </span>
          </div>
          <div
            v-if="!backups.length"
            class="empty-row"
          >
            No backup destination yet.
          </div>
        </div>
      </div>
      <div
        v-if="adding"
        class="adv"
      >
        <PrefRow title="Destination">
          <select
            v-model="draft.kind"
            class="sel"
            aria-label="Backup destination type"
          >
            <option value="local">This Mac (Sulla’s VM disk)</option>
            <option value="nas">NAS (SMB or NFS)</option>
            <option value="s3">S3-compatible storage</option>
          </select>
        </PrefRow>
        <PrefRow title="Name">
          <input
            v-model="draft.label"
            class="inp"
            aria-label="Backup name"
          >
        </PrefRow>
        <PrefRow
          v-if="draft.kind === 'local'"
          title="Folder name"
          subtitle="Protects against mistakes, not disk loss: it lives on this Mac."
        >
          <input
            v-model="draft.subfolder"
            class="inp"
            aria-label="Folder name"
          >
        </PrefRow>
        <template v-if="draft.kind === 'nas'">
          <PrefRow title="Share address">
            <input
              v-model="draft.share"
              class="inp"
              placeholder="smb://nas.local/backups"
              aria-label="Share address"
            >
          </PrefRow>
          <PrefRow title="Protocol">
            <select
              v-model="draft.protocol"
              class="sel"
              aria-label="Protocol"
            >
              <option value="smb">SMB</option>
              <option value="nfs">NFS</option>
            </select>
          </PrefRow>
        </template>
        <template v-if="draft.kind === 's3'">
          <PrefRow title="Endpoint">
            <input
              v-model="draft.endpoint"
              class="inp"
              placeholder="https://"
              aria-label="Endpoint"
            >
          </PrefRow>
          <PrefRow title="Bucket">
            <input
              v-model="draft.bucket"
              class="inp"
              aria-label="Bucket"
            >
          </PrefRow>
          <PrefRow
            title="Region"
            subtitle="Leave empty for us-east-1."
          >
            <input
              v-model="draft.region"
              class="inp"
              aria-label="Region"
            >
          </PrefRow>
        </template>
        <PrefRow
          v-if="draft.kind !== 'local'"
          title="Passwords item"
          subtitle="The ID of a Passwords item with backup_kind and backup_target set to this share or endpoint."
        >
          <input
            v-model="draft.credentialId"
            class="inp"
            aria-label="Passwords item ID"
          >
        </PrefRow>
        <PrefRow>
          <button
            type="button"
            class="btn sm ghost"
            @click="adding = false"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn sm pri"
            :disabled="!draft.label.trim() || busy.has('add-backup')"
            @click="addBackup"
          >
            Add destination
          </button>
        </PrefRow>
      </div>
      <p
        v-if="error"
        class="note badc"
        role="alert"
      >
        {{ error }}
      </p>
    </PrefCard>
  </div>
</template>

<style scoped>
.storage-actions,.storage-footer,.storage-review-actions{display:flex;align-items:center;gap:8px}.storage-actions{justify-content:flex-end}.storage-segment{display:flex;padding:2px;border:1px solid var(--border-default);border-radius:8px;background:var(--bg-surface-alt)}.storage-segment button{border:0;border-radius:6px;padding:5px 10px;background:transparent;color:var(--text-muted)}.storage-segment button.on{background:var(--bg-surface);color:var(--text-primary);box-shadow:0 1px 2px color-mix(in srgb,var(--text-primary) 10%,transparent)}.storage-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;margin:0 18px 12px;border:1px solid var(--border-subtle);border-radius:10px;overflow:hidden;background:var(--border-subtle)}.storage-summary>span{display:grid;gap:2px;padding:12px;background:var(--bg-surface)}.storage-summary b{font-size:16px;font-variant-numeric:tabular-nums}.storage-summary small,.storage-row small,.storage-review small{display:block;color:var(--text-muted)}.storage-group{margin:10px 18px;border:1px solid var(--border-subtle);border-radius:10px;overflow:hidden}.storage-group-head{display:flex;align-items:center;gap:12px;padding:9px 12px;background:var(--bg-surface-alt);font-size:12px}.storage-group-head b{margin-right:auto;font-size:13px}.storage-group-head span{color:var(--text-muted);font-variant-numeric:tabular-nums}.storage-table-head,.storage-row{display:grid;grid-template-columns:48px minmax(120px,1fr) 100px 110px minmax(220px,1.7fr);align-items:start;gap:10px;padding:9px 12px}.storage-table-head{font-size:10.5px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--text-dim);border-bottom:1px solid var(--border-subtle)}.storage-row+.storage-row,.storage-detail+.storage-row{border-top:1px solid var(--border-subtle)}.storage-row{font-size:12px}.storage-location{display:grid;gap:3px}.storage-details-button{width:max-content;padding:0;border:0;background:none;color:var(--text-link);font-size:11px}.storage-assessment{text-transform:capitalize}.storage-assessment.eligible{color:var(--status-success)}.storage-assessment.protected{color:var(--text-muted)}.storage-assessment.blocked,.storage-assessment.unknown{color:var(--status-warning)}.storage-detail{display:flex;flex-wrap:wrap;gap:8px 16px;padding:8px 12px 10px 70px;border-top:1px dashed var(--border-subtle);font-size:11px;color:var(--text-muted)}.storage-detail .mono{max-width:100%;overflow-wrap:anywhere;color:var(--text-primary)}.storage-footer{justify-content:flex-end;padding:2px 18px 12px}.storage-footer .note{margin-right:auto}.storage-review,.storage-outcome{margin:0 18px 12px;padding:12px;border:1px solid var(--border-default);border-radius:10px;background:var(--bg-surface-alt)}.storage-review{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 18px;align-items:start}.storage-review>div:first-child{display:grid;gap:3px}.storage-review-list{grid-column:1/-1;min-width:0;display:grid;gap:7px;margin:0;padding:0;list-style:none}.storage-review-list li>*{min-width:0;overflow-wrap:anywhere}.storage-review-list li{min-width:0;display:grid;gap:2px;padding:8px;border:1px solid var(--border-subtle);border-radius:7px;background:var(--bg-surface)}.storage-review-list .mono{overflow-wrap:anywhere;font-size:11px;color:var(--text-muted)}.storage-review-list .blocked{border-color:var(--status-warning)}.storage-outcome{display:grid;gap:4px;font-size:12px}.storage-outcome span{min-width:0;overflow-wrap:anywhere;color:var(--text-muted)}
@media(max-width:760px){.storage-summary{grid-template-columns:1fr}.storage-table-head{display:none}.storage-row{grid-template-columns:32px 1fr}.storage-row>span:nth-child(n+3){grid-column:2}.storage-group-head{align-items:flex-start;flex-wrap:wrap}.storage-group-head b{width:100%}.storage-footer,.storage-review{align-items:stretch;flex-direction:column}.storage-review-actions{justify-content:flex-end}.storage-detail{padding-left:54px}}
</style>
