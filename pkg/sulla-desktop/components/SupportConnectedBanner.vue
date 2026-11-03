<!-- Sulla Desktop · https://sulladesktop.com | Copyright (c) 2025-2026 Merchant Protocol LLC. | SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <div v-if="remote.status === 'connected'" class="support-connected" role="status">
    <i />
    <b>{{ remote.offeredBy || 'Sulla support' }} is connected</b>
    <span>Inside your Sulla runtime only · expires {{ expiry }}</span>
    <button type="button" @click="openSupport">View activity</button>
    <button type="button" class="end" :disabled="ending" @click="endSupport">End support</button>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type Remote = { status: string; offeredBy?: string; expiresAt?: string };
const remote = ref<Remote>({ status: 'idle' });
const ending = ref(false);
const expiry = computed(() => remote.value.expiresAt ? new Date(remote.value.expiresAt).toLocaleString() : 'soon');
const onState = (_event: unknown, value: Remote) => { remote.value = value };
async function endSupport() { ending.value = true; try { const state = await ipcRenderer.invoke('support:remote-banner-end'); remote.value = state.remote } finally { ending.value = false } }
function openSupport() { ipcRenderer.send('support:open-remote') }
onMounted(async() => { remote.value = await ipcRenderer.invoke('support:remote-banner-state'); ipcRenderer.on('support:remote-state', onState) });
onBeforeUnmount(() => ipcRenderer.removeListener('support:remote-state', onState));
</script>

<style scoped>
.support-connected {
  grid-area: support;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 38px;
  padding: 5px 14px;
  background: var(--status-success);
  color: var(--text-on-accent);
  font-size: 12px;
}
.support-connected i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bg-surface);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--text-on-accent) 18%, transparent);
}
.support-connected span { opacity: .84; }
.support-connected button {
  margin-left: auto;
  padding: 4px 9px;
  border: 1px solid color-mix(in srgb, var(--text-on-accent) 45%, transparent);
  border-radius: 7px;
  background: transparent;
  color: var(--text-on-accent);
  cursor: pointer;
}
.support-connected button + button { margin-left: 0; }
/* Deliberate inverted light pill: the surface token supplies its light fill. */
.support-connected .end {
  background: var(--bg-surface);
  color: var(--status-error);
  border-color: var(--border-default);
}
.support-connected button:disabled { opacity: .55; }
</style>
