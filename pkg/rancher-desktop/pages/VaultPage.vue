<template>
  <div
    ref="host"
    class="vault-host"
    :class="{ popup: props.surface === 'popup' }"
    aria-label="Password Manager"
  >
    <div v-if="error" class="vault-state">
      <strong>Vault unavailable</strong>
      <span>{{ error }}</span>
      <button type="button" @click="open">Retry</button>
    </div>
    <div v-else-if="loading" class="vault-state">Opening secure vault…</div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type WatchStopHandle } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const host = ref<HTMLElement | null>(null);
const props = withDefaults(defineProps<{
  integrationId?: string;
  accountId?: string;
  surface?: 'page' | 'popup';
  siteUrl?: string;
  tabId?: string;
  active?: boolean;
}>(), { surface: 'page', siteUrl: '', active: true });
const loading = ref(true);
const error = ref('');
const ownerId = crypto.randomUUID();
let observer: ResizeObserver | null = null;
let stopActiveWatch: WatchStopHandle | null = null;
let lifecycleGeneration = 0;

function bounds(): { x: number; y: number; width: number; height: number } {
  const rect = host.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

async function open(): Promise<void> {
  const generation = ++lifecycleGeneration;
  loading.value = true;
  error.value = '';
  await nextTick();
  if (!props.active || generation !== lifecycleGeneration) return;
  try {
    await ipcRenderer.invoke('vault:view-open', bounds(), {
      integrationId: props.integrationId,
      accountId:     props.accountId,
      surface:       props.surface,
      siteUrl:       props.siteUrl,
      tabId:         props.tabId,
      ownerId,
    });
    if (!props.active || generation !== lifecycleGeneration) return;
    loading.value = false;
  } catch (cause) {
    if (!props.active || generation !== lifecycleGeneration) return;
    loading.value = false;
    error.value = cause instanceof Error ? cause.message : 'The local vault service did not answer.';
  }
}

function hide(): void {
  lifecycleGeneration += 1;
  void ipcRenderer.invoke('vault:view-hide', ownerId);
}

onMounted(() => {
  observer = new ResizeObserver(() => {
    if (props.active) void ipcRenderer.invoke('vault:view-bounds', ownerId, bounds());
  });
  if (host.value) observer.observe(host.value);
  stopActiveWatch = watch(() => props.active, (active) => {
    if (active) void open();
    else hide();
  }, { immediate: true });
});

onBeforeUnmount(() => {
  stopActiveWatch?.();
  stopActiveWatch = null;
  observer?.disconnect();
  observer = null;
  hide();
});
</script>

<style scoped>
.vault-host { position: relative; width: 100%; height: 100%; min-height: 420px; background: var(--bg-page, #0d1117); }
.vault-host.popup { min-height: 100%; background: #f4f7fb; }
.vault-state { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .75rem; color: var(--text-secondary, #8b949e); }
.vault-state strong { color: var(--text-primary, #e6edf3); }
.vault-state button { border: 1px solid var(--border-default, #30363d); border-radius: .5rem; padding: .5rem .9rem; background: var(--accent-primary, #5096b3); color: #fff; }
</style>
