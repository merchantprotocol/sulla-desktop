<template>
  <div class="vault-unlock-screen">
    <WindowDragLogo :size="20" class="vault-drag-logo" />
    <div v-if="waitingServices.length" class="vault-waiting" role="status"><strong>Unlock to finish starting Sulla.</strong><span>{{ waitingServices.join(' · ') }} are waiting.</span></div>
    <VaultPage class="vault-secure-surface" modal />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import VaultPage from '@pkg/pages/VaultPage.vue';
import WindowDragLogo from '@pkg/components/WindowDragLogo.vue';
import { useVaultUnlock } from '@pkg/composables/useVaultUnlock';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { StartupProgressSnapshot } from '@pkg/utils/startupProgress';

const emit = defineEmits<{ unlocked: [] }>();
const { refreshStatus } = useVaultUnlock();
const waitingServices = ref<string[]>([]);
function updateWaiting(_event:unknown, snapshot:StartupProgressSnapshot) { waitingServices.value = snapshot.services.filter(s => s.status === 'waiting-on-unlock').map(s => s.label); }
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  ipcRenderer.on('startup-progress', updateWaiting);
  void ipcRenderer.invoke('startup-progress').then(snapshot => updateWaiting(undefined, snapshot));
  timer = setInterval(async() => {
    if (await refreshStatus()) emit('unlocked');
  }, 750);
});

onBeforeUnmount(() => {
  ipcRenderer.removeListener('startup-progress', updateWaiting);
  if (timer) clearInterval(timer);
  timer = null;
});
</script>

<style scoped>
.vault-waiting { position: fixed; z-index: 100001; top: 52px; left: 50%; transform: translateX(-50%); display: flex; gap: .5rem; padding: .55rem .8rem; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); color: var(--text); font-size: 12px; }
.vault-waiting span { color: var(--text-muted); }
.vault-unlock-screen { position: fixed; inset: 0; z-index: 99999; display: flex; background: var(--bg-page, #0d1117); }
.vault-drag-logo { position: fixed; top: 10px; left: 80px; z-index: 100000; }
.vault-secure-surface { flex: 1; margin-top: 42px; min-height: 0; }
</style>
