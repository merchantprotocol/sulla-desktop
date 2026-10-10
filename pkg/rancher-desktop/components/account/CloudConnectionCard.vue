<template>
  <div class="cc">
    <div
      v-if="status?.device?.revoked"
      class="cc-alert"
    >
      This desktop was removed from your Sulla Cloud account. Restore it from the Desktops page at sulladesktop.com to reconnect.
    </div>
    <div
      v-else-if="status?.device?.error"
      class="cc-alert"
    >
      Sulla Cloud refused this desktop's key ({{ status.device.error }}). Nothing can control this computer from the web until that's resolved.
    </div>

    <div class="cc-row">
      <span class="cc-label">Secure channel</span>
      <span :class="['cc-pill', channelClass]">{{ channelLabel }}</span>
    </div>
    <div
      v-if="status?.keyFingerprint"
      class="cc-row"
    >
      <span class="cc-label">Device key</span>
      <code class="cc-mono">{{ status.keyFingerprint }}</code>
    </div>
    <p class="cc-hint">
      The same fingerprint appears next to this desktop on the Desktops page. Its private key never leaves this computer.
    </p>

    <h3 class="cc-title">
      Remote access
    </h3>
    <label class="cc-toggle">
      <input
        type="checkbox"
        :checked="!!status?.preferences?.remoteAccess"
        :disabled="busy"
        @change="setPref('remoteAccess', ($event.target as HTMLInputElement).checked)"
      >
      <span>Let browsers and phones I approve here send commands to this computer</span>
    </label>
    <p class="cc-hint">
      A new browser asks first. You approve it here after checking that the 6-digit code matches, and every command it sends afterwards is signed with its key.
    </p>
    <div
      v-if="status?.approvedClients?.length"
      class="cc-list"
    >
      <div
        v-for="c in status.approvedClients"
        :key="c.clientId"
        class="cc-item"
      >
        <div>
          <div class="cc-item-title">
            {{ c.label }}
          </div>
          <div class="cc-item-sub">
            {{ c.surface === 'mobile' ? 'Phone' : 'Browser' }} · approved {{ fmt(c.approvedAt) }}<span v-if="c.lastUsedAt"> · last used {{ fmt(c.lastUsedAt) }}</span>
          </div>
        </div>
        <button
          type="button"
          class="cc-btn cc-btn-danger"
          :disabled="busy"
          @click="revoke(c.clientId)"
        >
          Revoke
        </button>
      </div>
    </div>
    <p
      v-else
      class="cc-hint"
    >
      No browsers or phones approved yet.
    </p>

    <h3 class="cc-title">
      Sync to Sulla Cloud
    </h3>
    <p class="cc-hint">
      Off unless you turn it on.
    </p>
    <div
      v-for="item in syncItems"
      :key="item.key"
      class="cc-sync"
    >
      <label class="cc-toggle">
        <input
          type="checkbox"
          :checked="!!status?.preferences?.[item.key]"
          :disabled="busy"
          @change="setPref(item.key, ($event.target as HTMLInputElement).checked)"
        >
        <span><strong>{{ item.title }}</strong> — {{ item.detail }}</span>
      </label>
      <div
        v-if="item.key !== 'conversations'"
        class="cc-sync-meta"
      >
        <span>{{ objectLine(item.key) }}</span>
        <button
          v-if="status?.preferences?.[item.key]"
          type="button"
          class="cc-btn"
          :disabled="busy"
          @click="syncNow(item.key)"
        >
          Sync now
        </button>
        <button
          type="button"
          class="cc-btn cc-btn-danger"
          :disabled="busy"
          @click="deleteCopy(item.key)"
        >
          Delete cloud copy
        </button>
      </div>
    </div>
    <p
      v-if="error"
      class="cc-error"
    >
      {{ error }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type Pref = 'conversations' | 'vault' | 'projects' | 'remoteAccess';

const status = ref<Record<string, any> | null>(null);
const busy = ref(false);
const error = ref('');

const syncItems: { key: 'conversations' | 'vault' | 'projects'; title: string; detail: string }[] = [
  { key: 'conversations', title: 'Conversations', detail: 'read and continue chats from the web and your phone.' },
  { key: 'vault', title: 'Password vault', detail: 'encrypted backup, locked with your master password. Sulla Cloud can\'t read it.' },
  { key: 'projects', title: 'Projects', detail: 'see projects and tasks on the web while this computer is off.' },
];

const channelLabel = computed(() => ({
  connected:  'Connected',
  connecting: 'Connecting…',
  error:      status.value?.channel?.lastError ? `Reconnecting — ${ status.value.channel.lastError }` : 'Reconnecting',
  stopped:    'Off',
} as Record<string, string>)[status.value?.channel?.state ?? 'stopped']);

const channelClass = computed(() => status.value?.channel?.state === 'connected' ? 'cc-pill-on' : 'cc-pill-off');

function fmt(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function objectLine(kind: 'vault' | 'projects') {
  const s = (status.value?.objectSync ?? []).find((o: any) => o.kind === kind);
  if (!s) return '';
  if (s.lastError) return `Last attempt failed: ${ s.lastError }`;
  if (s.skipped === 'vault_locked') return 'Waiting for the vault to be unlocked.';
  if (s.lastSyncAt) return `Last synced ${ fmt(s.lastSyncAt) }`;
  return '';
}

async function run(fn: () => Promise<any>) {
  busy.value = true;
  error.value = '';
  try {
    status.value = await fn();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function setPref(key: Pref, value: boolean) {
  return run(() => ipcRenderer.invoke('sulla-cloud-connection:set-preferences', { [key]: value }));
}

function revoke(clientId: string) {
  return run(() => ipcRenderer.invoke('sulla-cloud-connection:revoke-client', clientId));
}

function syncNow(kind: 'vault' | 'projects') {
  return run(() => ipcRenderer.invoke('sulla-cloud-connection:sync-now', kind));
}

function deleteCopy(kind: 'vault' | 'projects') {
  if (!window.confirm(`Delete the ${ kind === 'vault' ? 'vault' : 'Projects' } copy stored in Sulla Cloud? Nothing on this computer changes.`)) return;
  return run(async() => {
    await ipcRenderer.invoke('sulla-cloud-connection:set-preferences', { [kind]: false });
    return ipcRenderer.invoke('sulla-cloud-connection:delete-cloud-copy', kind);
  });
}

function onStatus(_e: unknown, s: Record<string, any>) {
  status.value = s;
}

onMounted(async() => {
  ipcRenderer.on('sulla-cloud-connection:status-changed', onStatus);
  await run(() => ipcRenderer.invoke('sulla-cloud-connection:get-status'));
});

onBeforeUnmount(() => {
  ipcRenderer.removeListener('sulla-cloud-connection:status-changed', onStatus);
});
</script>

<style scoped>
.cc { margin-top: 12px; }
.cc-alert {
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--border-error, #d73a49);
  border-radius: 8px;
  color: var(--text-error, #f85149);
  font-size: 13px;
}
.cc-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; font-size: 13px; }
.cc-label { color: var(--text-secondary, #8b949e); min-width: 120px; }
.cc-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.cc-pill { padding: 2px 8px; border-radius: 999px; font-size: 12px; }
.cc-pill-on { background: rgba(46, 160, 67, 0.15); color: var(--text-success, #3fb950); }
.cc-pill-off { background: var(--bg-surface-alt, #1c2128); color: var(--text-secondary, #8b949e); }
.cc-title { margin: 18px 0 6px; font-size: 14px; font-weight: 600; }
.cc-hint { margin: 4px 0 8px; font-size: 12px; color: var(--text-secondary, #8b949e); }
.cc-toggle { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; cursor: pointer; }
.cc-toggle input { margin-top: 3px; }
.cc-list { display: flex; flex-direction: column; gap: 6px; }
.cc-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 10px; border: 1px solid var(--border-default, #30363d); border-radius: 8px;
}
.cc-item-title { font-size: 13px; }
.cc-item-sub { font-size: 12px; color: var(--text-secondary, #8b949e); }
.cc-sync { margin-bottom: 10px; }
.cc-sync-meta { display: flex; gap: 8px; align-items: center; margin: 4px 0 0 22px; font-size: 12px; color: var(--text-secondary, #8b949e); }
.cc-btn {
  padding: 3px 10px; font-size: 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--border-default, #30363d); background: var(--bg-surface-alt, #1c2128); color: var(--text-primary, #e6edf3);
}
.cc-btn:disabled { opacity: 0.5; cursor: default; }
.cc-btn-danger { color: var(--text-error, #f85149); }
.cc-error { color: var(--text-error, #f85149); font-size: 12px; }

:global(.theme-noir) .cc {
  margin-top: 18px;
  color: var(--nx-read-2);
}

:global(.theme-noir) .cc-row,
:global(.theme-noir) .cc-item,
:global(.theme-noir) .cc-sync {
  padding: 12px 14px;
  border: 1px solid var(--nx-hair);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-surface-alt) 38%, transparent);
}

:global(.theme-noir) .cc-row {
  justify-content: space-between;
  margin: 8px 0;
}

:global(.theme-noir) .cc-label,
:global(.theme-noir) .cc-item-sub,
:global(.theme-noir) .cc-hint,
:global(.theme-noir) .cc-sync-meta {
  color: var(--nx-read-4);
}

:global(.theme-noir) .cc-title {
  margin-top: 24px;
  color: var(--nx-read-1);
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 1rem;
  font-weight: 500;
}

:global(.theme-noir) .cc-mono,
:global(.theme-noir) .cc-sync-meta {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.68rem;
}

:global(.theme-noir) .cc-pill {
  border: 1px solid var(--nx-hair);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.62rem;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

:global(.theme-noir) .cc-pill-on {
  border-color: color-mix(in srgb, var(--nx-success) 25%, transparent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--nx-success) 9%, transparent);
}

:global(.theme-noir) .cc-toggle input {
  width: 38px;
  height: 22px;
  flex: 0 0 38px;
  margin-top: 0;
  accent-color: var(--nx-accent);
}

:global(.theme-noir) .cc-btn {
  border-color: color-mix(in srgb, var(--nx-hair-strong) 62.5%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--nx-hair-strong) 28.125%, transparent);
  color: var(--nx-read-3);
}
</style>
