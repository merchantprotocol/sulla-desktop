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

import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { openMainTab } from '@pkg/composables/preferences/openInMain';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const visible = ref(false);
const providerIds = ['claude-code', 'codex', 'grok', 'anthropic', 'openai'];

async function refresh() {
  try {
    const service = getIntegrationService();
    const accounts = await Promise.all(providerIds.map(id => service.getAccounts(id).catch(() => [])));

    visible.value = !accounts.flat().some(account => account.connected);
  } catch {
    // A locked or still-starting vault is not evidence that the user has no model.
    visible.value = false;
  }
}

function openModels() { openMainTab('models'); }
function onModelChanged() { void refresh(); }

onMounted(() => {
  void refresh();
  ipcRenderer.on('model-provider:state-changed', onModelChanged);
});
onBeforeUnmount(() => ipcRenderer.removeListener('model-provider:state-changed', onModelChanged));
</script>

<style scoped>
.no-ai{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:10px 20px 0;padding:12px 14px;border:1px solid var(--border-default);border-radius:12px;background:var(--bg-surface-alt);color:var(--text-secondary);font-size:13px}.no-ai strong{color:var(--text-primary)}.no-ai button{flex:none;padding:8px 13px;border-radius:9px;background:var(--accent-primary);color:var(--text-on-accent);font-weight:650}@media(max-width:700px){.no-ai{align-items:flex-start;flex-direction:column}}
</style>
