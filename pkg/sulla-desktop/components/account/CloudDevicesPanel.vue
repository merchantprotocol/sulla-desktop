<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->

<!--
  Settings → Account → Devices. Thin view over the `sulla-cloud-devices:*` IPC;
  the rules (this computer can't be removed, removal is verified) live in
  main/cloud/devices/DevicesPanelService.ts.
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue';

import PrefCard from '@pkg/components/settings/PrefCard.vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface DeviceRow {
  id:             string;
  name:           string;
  deviceType:     string;
  platform:       string;
  model:          string | null;
  osVersion:      string | null;
  appVersion:     string | null;
  lastSeenAt:     string | null;
  online:         boolean;
  keyFingerprint: string | null;
  isThisDevice:   boolean;
}

const NAME_MAX = 120;
const PLATFORMS: Record<string, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux', ios: 'iOS', android: 'Android', web: 'Web' };

const devices = ref<DeviceRow[]>([]);
const loading = ref(true);
const loadError = ref('');
const rowError = ref<{ id: string; message: string } | null>(null);
const notice = ref('');
const renamingId = ref('');
const draftName = ref('');
const confirmingId = ref('');
const pendingId = ref('');

async function load() {
  loading.value = true;
  loadError.value = '';
  const res = await ipcRenderer.invoke('sulla-cloud-devices:list').catch(() => null);
  loading.value = false;
  if (res?.ok) devices.value = res.value.devices;
  else loadError.value = res?.error || 'Couldn’t load your devices.';
}

function startRename(device: DeviceRow) {
  confirmingId.value = '';
  rowError.value = null;
  renamingId.value = device.id;
  draftName.value = device.name;
}

async function saveRename(device: DeviceRow) {
  pendingId.value = device.id;
  rowError.value = null;
  const res = await ipcRenderer.invoke('sulla-cloud-devices:rename', device.id, draftName.value).catch(() => null);
  pendingId.value = '';
  if (!res?.ok) {
    rowError.value = { id: device.id, message: res?.error || 'Couldn’t rename the device.' };

    return;
  }
  devices.value = devices.value.map(d => (d.id === device.id ? res.value : d));
  renamingId.value = '';
}

async function remove(device: DeviceRow) {
  pendingId.value = device.id;
  rowError.value = null;
  notice.value = '';
  const res = await ipcRenderer.invoke('sulla-cloud-devices:remove', device.id).catch(() => null);
  pendingId.value = '';
  confirmingId.value = '';
  if (!res?.ok) {
    rowError.value = { id: device.id, message: res?.error || 'Couldn’t remove the device.' };
    if (res?.code === 'not_removed' || res?.code === 'unknown_device') void load();

    return;
  }
  devices.value = res.value.devices;
  notice.value = `Removed ${ device.name }.`;
}

function details(device: DeviceRow): string {
  const platform = PLATFORMS[device.platform] ?? device.platform;

  return [
    device.osVersion ? `${ platform } ${ device.osVersion }` : platform,
    device.model,
    device.appVersion ? `Sulla ${ device.appVersion }` : null,
  ].filter(Boolean).join(' · ');
}

function seen(device: DeviceRow): string {
  if (device.online) return 'Online';
  const at = device.lastSeenAt ? Date.parse(device.lastSeenAt) : NaN;
  if (Number.isNaN(at)) return 'Never seen';
  const minutes = Math.max(1, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `Last seen ${ minutes } min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last seen ${ hours } h ago`;

  return `Last seen ${ new Date(at).toLocaleDateString() }`;
}

onMounted(load);
</script>

<template>
  <PrefCard
    title="Devices"
    subtitle="Computers and phones signed in to your Sulla Cloud account."
  >
    <template #actions>
      <button
        type="button"
        class="btn sm ghost"
        :disabled="loading"
        @click="load"
      >
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
    </template>

    <div class="set col">
      <div
        v-if="loadError"
        class="k"
      >
        <span class="badc">{{ loadError }}</span>
        <button
          type="button"
          class="btn sm"
          @click="load"
        >
          Retry
        </button>
      </div>
      <div
        v-else-if="loading && !devices.length"
        class="dimc"
      >
        Loading…
      </div>
      <div
        v-else
        class="lst devices"
      >
        <div
          v-if="!devices.length"
          class="empty-row"
        >
          No devices yet.
        </div>
        <div
          v-for="device in devices"
          :key="device.id"
          class="device"
        >
          <div class="device-main">
            <span
              class="dot"
              :class="{ off: !device.online }"
            />
            <span class="grow">
              <template v-if="renamingId === device.id">
                <input
                  v-model="draftName"
                  class="inp"
                  :maxlength="NAME_MAX"
                  aria-label="Device name"
                  :disabled="pendingId === device.id"
                  @keydown.enter.prevent="saveRename(device)"
                  @keydown.esc.prevent="renamingId = ''"
                >
              </template>
              <b v-else>{{ device.name }}</b>
              <span
                v-if="device.isThisDevice"
                class="soon this"
              >This computer</span>
              <small>{{ details(device) }}</small>
              <small>
                {{ seen(device) }}
                <template v-if="device.keyFingerprint"> · Key <span class="mono">{{ device.keyFingerprint }}</span></template>
              </small>
            </span>
            <span class="r">
              <template v-if="renamingId === device.id">
                <button
                  type="button"
                  class="btn sm ghost"
                  :disabled="pendingId === device.id"
                  @click="renamingId = ''"
                >Cancel</button>
                <button
                  type="button"
                  class="btn sm pri"
                  :disabled="pendingId === device.id || !draftName.trim()"
                  @click="saveRename(device)"
                >{{ pendingId === device.id ? 'Saving…' : 'Save' }}</button>
              </template>
              <template v-else-if="confirmingId !== device.id">
                <button
                  type="button"
                  class="btn sm ghost"
                  :disabled="!!pendingId"
                  @click="startRename(device)"
                >Rename</button>
                <button
                  v-if="!device.isThisDevice"
                  type="button"
                  class="btn sm danger"
                  :disabled="!!pendingId"
                  @click="confirmingId = device.id; renamingId = ''; rowError = null"
                >Remove…</button>
              </template>
            </span>
          </div>
          <div
            v-if="confirmingId === device.id"
            class="alert warn confirm"
          >
            <div class="x">
              <b>Remove {{ device.name }}?</b>
              <span>It stops syncing and can’t reach this account until it’s set up again.</span>
            </div>
            <div class="r">
              <button
                type="button"
                class="btn sm ghost"
                :disabled="pendingId === device.id"
                @click="confirmingId = ''"
              >Cancel</button>
              <button
                type="button"
                class="btn sm danger"
                :disabled="pendingId === device.id"
                @click="remove(device)"
              >{{ pendingId === device.id ? 'Removing…' : 'Remove' }}</button>
            </div>
          </div>
          <p
            v-if="rowError?.id === device.id"
            class="badc row-error"
          >
            {{ rowError.message }}
          </p>
        </div>
      </div>
    </div>
    <p
      v-if="notice"
      class="note"
    >
      {{ notice }}
    </p>
  </PrefCard>
</template>

<style scoped>
.devices > .device{flex-direction:column;align-items:stretch;gap:8px}
.device-main{display:flex;align-items:center;gap:10px}
.device-main .grow small{display:block}
.device .inp{max-width:280px}
.soon.this{margin-left:8px;background:var(--accent-soft);color:var(--accent-2)}
.confirm{margin:0}
.row-error{margin:0;font-size:12px}
</style>
