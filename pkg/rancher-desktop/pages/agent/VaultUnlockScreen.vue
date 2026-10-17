<template>
  <div class="vault-unlock-screen">
    <WindowDragLogo :size="20" class="vault-drag-logo" />
    <VaultPage class="vault-secure-surface" />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';

import VaultPage from '@pkg/pages/VaultPage.vue';
import WindowDragLogo from '@pkg/components/WindowDragLogo.vue';
import { useVaultUnlock } from '@pkg/composables/useVaultUnlock';

const emit = defineEmits<{ unlocked: [] }>();
const { refreshStatus } = useVaultUnlock();
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  timer = setInterval(async() => {
    if (await refreshStatus()) emit('unlocked');
  }, 750);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  timer = null;
});
</script>

<style scoped>
.vault-unlock-screen { position: fixed; inset: 0; z-index: 99999; display: flex; background: var(--bg-page, #0d1117); }
.vault-drag-logo { position: fixed; top: 10px; left: 80px; z-index: 100000; }
.vault-secure-surface { flex: 1; margin-top: 42px; min-height: 0; }
</style>
