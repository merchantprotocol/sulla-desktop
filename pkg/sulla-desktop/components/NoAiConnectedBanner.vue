<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <aside v-if="visible" class="no-ai" role="status">
    <div><strong>Connect an AI model to start chatting.</strong><span> Sign in to Claude, ChatGPT, or Grok, or add an API key.</span></div>
    <button type="button" @click="openModels">Connect a model</button>
  </aside>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { integrations } from '@pkg/agent/integrations/catalog';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { openMainTab } from '@pkg/composables/preferences/openInMain';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const visible = ref(false);
const requestedIntegration = ref<string | null>(null);
let openedGuidedConnect = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

async function openVaultConnect(integrationId: string) {
  const integration = integrations[integrationId];
  const fields = await Promise.all((integration?.properties ?? [])
    .filter(property => property.key !== 'llm_access')
    .map(async(property) => {
      let options: { label: string; value: string }[] = [];
      if (property.type === 'select' && property.selectBoxId) {
        options = await getIntegrationService().getSelectOptions(property.selectBoxId, integrationId, 'default', {})
          .catch(() => []);
      }
      return {
        key: property.key, title: property.title, hint: property.hint, type: property.type,
        required: property.type === 'select' && !options.length ? false : property.required,
        placeholder: property.placeholder, options,
      };
    }));
  window.dispatchEvent(new CustomEvent('sulla:open-secure-vault', {
    detail: { integrationId, connect: integration ? {
      name: integration.name, description: integration.description, formGuide: integration.formGuide, fields,
    } : undefined },
  }));
  ipcRenderer.send('first-run:trace' as any, 'main-window', 'opened deferred API connection', { integrationId });
}

async function refresh() {
  const status = await ipcRenderer.invoke('first-run-ai:connection-status' as any)
    .catch(() => ({ connected: false, loading: true }));
  if (status.loading) {
    visible.value = false;
    return;
  }

  const firstRun = await ipcRenderer.invoke('first-run-state:get' as any).catch(() => null);
  const choice = firstRun?.choices?.aiApiProvider;
  requestedIntegration.value = typeof choice === 'string' ? choice : null;
  visible.value = !status.connected;

  if (status.connected && requestedIntegration.value) {
    const choices = { ...(firstRun?.choices ?? {}) };
    delete choices.aiApiProvider;
    await ipcRenderer.invoke('first-run-state:set' as any, { choices }).catch(() => undefined);
    requestedIntegration.value = null;
  }

  if (visible.value && requestedIntegration.value && !openedGuidedConnect) {
    openedGuidedConnect = true;
    openVaultConnect(requestedIntegration.value);
  }
}

function openModels() {
  if (requestedIntegration.value) void openVaultConnect(requestedIntegration.value);
  else openMainTab('integrations');
}
function onModelChanged() { void refresh(); }
function onOpenConnections() { openModels(); }
function onVaultUnlocked() { void refresh(); }

onMounted(() => {
  void refresh();
  refreshTimer = setInterval(refresh, 2_000);
  ipcRenderer.on('model-provider:state-changed', onModelChanged);
  ipcRenderer.on('vault:logged-in' as any, onVaultUnlocked);
  window.addEventListener('sulla:open-ai-connections', onOpenConnections);
});
onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  ipcRenderer.removeListener('model-provider:state-changed', onModelChanged);
  ipcRenderer.removeListener('vault:logged-in' as any, onVaultUnlocked);
  window.removeEventListener('sulla:open-ai-connections', onOpenConnections);
});
</script>

<style scoped>
.no-ai{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:10px 20px 0;padding:12px 14px;border:1px solid var(--border-default);border-radius:12px;background:var(--bg-surface-alt);color:var(--text-secondary);font-size:13px}.no-ai strong{color:var(--text-primary)}.no-ai button{flex:none;padding:8px 13px;border-radius:9px;background:var(--accent-primary);color:var(--text-on-accent);font-weight:650}@media(max-width:700px){.no-ai{align-items:flex-start;flex-direction:column}}
</style>
