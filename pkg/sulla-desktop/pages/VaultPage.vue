<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div
    ref="host"
    class="vault-host"
    :class="{ popup: props.surface === 'popup' }"
    aria-label="Password Manager"
  >
    <ConfigurationLoadState
      v-if="loading || starting || error"
      class="vault-state"
      :label="starting ? 'Waiting for Password Vault…' : 'Opening Password Vault…'"
      :error="error"
      @retry="open"
    />
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type WatchStopHandle } from 'vue';

import ConfigurationLoadState from '@pkg/components/settings/ConfigurationLoadState.vue';
import { ConfigurationLoadPolicy } from '@pkg/composables/useConfigurationLoad';
import { useTheme } from '@pkg/composables/useTheme';
import { readVaultTheme } from '@pkg/shared/vaultTheme';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const host = ref<HTMLElement | null>(null);
const { currentTheme } = useTheme();
const props = withDefaults(defineProps<{
  integrationId?: string;
  accountId?: string;
  surface?: 'page' | 'popup';
  siteUrl?: string;
  tabId?: string;
  active?: boolean;
  modal?: boolean;
  restoreFiles?: boolean;
  /** Public integration form (labels, hints, setup notes) for the guided Connect screen. */
  connect?: Record<string, unknown>;
}>(), { surface: 'page', siteUrl: '', active: true, modal: false });
const loading = ref(true);
const error = ref('');
const starting = ref(false);
const loadPolicy = new ConfigurationLoadPolicy();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let opening = false;
const ownerId = crypto.randomUUID();
let observer: ResizeObserver | null = null;
let stopActiveWatch: WatchStopHandle | null = null;
let lifecycleGeneration = 0;
const claimant: Claimant = { ownerId, modal: props.modal, reopen: () => { void open() } };

function canOpen(): boolean {
  return props.active && viewHolder() === claimant && !document.hidden;
}

function retryWhenVisible(): void {
  starting.value = true;
  if (!canOpen()) return;
  retryTimer = setTimeout(() => { retryTimer = null; void open() }, 2_000);
}

function onVisibilityChange(): void {
  if (canOpen() && !opening && !retryTimer && (loading.value || starting.value)) void open();
}

function bounds(): { x: number; y: number; width: number; height: number } {
  const rect = host.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

async function open(): Promise<void> {
  const generation = ++lifecycleGeneration;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  loading.value = true;
  error.value = '';
  await nextTick();
  if (!canOpen() || generation !== lifecycleGeneration) return;
  opening = true;
  try {
    const result = await ipcRenderer.invoke('vault:view-open', bounds(), {
      integrationId: props.integrationId,
      accountId:     props.accountId,
      surface:       props.surface,
      siteUrl:       props.siteUrl,
      tabId:         props.tabId,
      ownerId,
      theme:        readVaultTheme(document),
      restoreFiles: props.restoreFiles,
      connect:      props.connect ? JSON.parse(JSON.stringify(props.connect)) : undefined,
    });
    if (generation !== lifecycleGeneration) return;
    if (result.state === 'cancelled') {
      retryWhenVisible();
      return;
    }
    loading.value = false;
    starting.value = false;
  } catch (cause) {
    if (generation !== lifecycleGeneration) return;
    if (loadPolicy.isTransient(cause)) {
      retryWhenVisible();
      return;
    }
    loading.value = false;
    starting.value = false;
    error.value = cause instanceof Error ? cause.message : 'The local vault service did not answer.';
  } finally {
    if (generation === lifecycleGeneration) opening = false;
  }
}

watch(currentTheme, async() => {
  await nextTick();
  if (props.active && viewHolder() === claimant) {
    await ipcRenderer.invoke('vault:view-theme', ownerId, readVaultTheme(document));
  }
});

function hide(): void {
  lifecycleGeneration += 1;
  opening = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  void ipcRenderer.invoke('vault:view-hide', ownerId);
}

function activate(): void {
  release(claimant);
  claimants.push(claimant);
  if (viewHolder() === claimant) void open();
}

function deactivate(): void {
  const wasHolder = viewHolder() === claimant;
  release(claimant);
  hide();
  // Hand the single native view back to whoever it was taken from (e.g. the vault tab after unlock).
  if (wasHolder) viewHolder()?.reopen();
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange);
  observer = new ResizeObserver(() => {
    if (props.active) void ipcRenderer.invoke('vault:view-bounds', ownerId, bounds());
  });
  if (host.value) observer.observe(host.value);
  stopActiveWatch = watch(() => props.active, (active) => {
    if (active) activate();
    else deactivate();
  }, { immediate: true });
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopActiveWatch?.();
  stopActiveWatch = null;
  observer?.disconnect();
  observer = null;
  deactivate();
});
</script>

<script lang="ts">
// The window has one native vault view. Every mounted, active VaultPage claims it;
// the modal unlock screen wins, otherwise the most recently activated one does.
interface Claimant { ownerId: string; modal: boolean; reopen: () => void }
const claimants: Claimant[] = [];

function viewHolder(): Claimant | undefined {
  return claimants.findLast(c => c.modal) ?? claimants.at(-1);
}

function release(claimant: Claimant): void {
  const index = claimants.indexOf(claimant);
  if (index >= 0) claimants.splice(index, 1);
}
</script>

<style scoped>
.vault-host { position: relative; width: 100%; height: 100%; min-height: 420px; background: var(--bg-page); }
.vault-host.popup { min-height: 100%; background: var(--bg-page); }
.vault-state { position: absolute; inset: 0; }
</style>
