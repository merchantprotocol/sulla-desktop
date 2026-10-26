<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';

import PrefCard from '../PrefCard.vue';
import PrefIcon from '../PrefIcon.vue';
import PrefMore from '../PrefMore.vue';
import PrefRow from '../PrefRow.vue';
import PrefToggle from '../PrefToggle.vue';

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
  await Promise.all([loadRoots(), loadBackups(), loadFinder()]);
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
