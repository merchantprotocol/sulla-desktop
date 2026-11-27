<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <form
    class="space-y-5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6"
    @submit.prevent="save"
  >
    <h3 class="text-lg font-semibold text-[var(--text-primary)]">
      Clerk connection
    </h3>
    <p class="text-sm text-[var(--text-secondary)]">
      Enter both keys for any environment you want to use. Unchanged sections keep their saved keys. Calls default to staging; production writes wait for approval.
    </p>
    <div
      v-if="errors.length"
      ref="banner"
      role="alert"
      class="space-y-1 rounded-lg border border-[var(--status-error)] bg-[var(--status-error-soft)] px-4 py-3 text-sm font-medium text-[var(--status-error)]"
    >
      <p
        v-for="line in errors"
        :key="line"
      >
        {{ line }}
      </p>
    </div>
    <p
      v-if="notice"
      role="status"
      class="rounded-lg border border-[var(--status-success)] bg-[var(--status-success-soft)] px-4 py-3 text-sm font-medium text-[var(--status-success)]"
    >
      {{ notice }}
    </p>
    <fieldset
      v-for="section in sections"
      :key="section.id"
      :disabled="busy"
      class="space-y-3 rounded-lg border p-4"
      :class="sectionErrors[section.id] ? 'border-[var(--status-error)]' : 'border-[var(--border-subtle)]'"
    >
      <legend class="px-2 font-medium text-[var(--text-primary)]">
        {{ section.label }}
      </legend>
      <p
        class="text-sm"
        :class="settings?.[section.id].connected ? 'font-medium text-[var(--status-success)]' : 'text-[var(--text-secondary)]'"
      >
        {{ settings?.[section.id].connected ? 'Connected' : 'Not connected' }}
      </p>
      <p
        v-if="sectionErrors[section.id]"
        class="text-sm font-medium text-[var(--status-error)]"
      >
        {{ sectionErrors[section.id] }}
      </p>
      <p
        v-if="settings?.[section.id].warning"
        class="text-sm text-[var(--text-primary)]"
      >
        {{ settings[section.id].warning }}
      </p>
      <label class="block space-y-1 text-sm text-[var(--text-primary)]">
        <span>Publishable key</span>
        <input
          v-model="keys[section.id].publishable"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="settings?.[section.id].publishableKey || section.publishablePrefix"
          class="block w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2"
        >
      </label>
      <label class="block space-y-1 text-sm text-[var(--text-primary)]">
        <span>Secret key</span>
        <input
          v-model="keys[section.id].secret"
          type="password"
          autocomplete="new-password"
          :placeholder="settings?.[section.id].connected ? 'Saved in Vault' : section.secretPrefix"
          class="block w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2"
        >
      </label>
      <button
        v-if="settings?.[section.id].connected"
        type="button"
        class="text-sm text-[var(--text-secondary)] underline"
        @click="disconnectSection(section.id)"
      >
        Disconnect {{ section.label }}
      </button>
    </fieldset>
    <fieldset
      class="space-y-3 rounded-lg border border-[var(--border-subtle)] p-4"
      :disabled="busy"
    >
      <legend class="px-2 font-medium text-[var(--text-primary)]">
        Allowed agents
      </legend>
      <p class="text-sm text-[var(--text-secondary)]">
        By default, all agents may use Clerk. Choose specific agents to restrict access.
      </p>
      <label class="flex items-center gap-2 text-sm text-[var(--text-primary)]">
        <input
          v-model="allowAllAgents"
          type="radio"
          name="clerk-agent-access"
          :value="true"
        >
        All agents
      </label>
      <label class="flex items-center gap-2 text-sm text-[var(--text-primary)]">
        <input
          v-model="allowAllAgents"
          type="radio"
          name="clerk-agent-access"
          :value="false"
        >
        Only selected agents
      </label>
      <p
        v-if="agentsLoading"
        class="text-sm text-[var(--text-secondary)]"
      >
        Loading agents…
      </p>
      <p
        v-else-if="agentsError && !allowAllAgents"
        role="alert"
        class="text-sm font-medium text-[var(--status-error)]"
      >
        {{ agentsError }}
      </p>
      <div
        v-else-if="!allowAllAgents"
        class="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-[var(--border-subtle)] p-3"
      >
        <label
          v-for="agent in agents"
          :key="agent.slug"
          class="flex items-center gap-2 text-sm text-[var(--text-primary)]"
        >
          <input
            v-model="selectedAgentIds"
            type="checkbox"
            :value="agent.slug"
          >
          <span>{{ agent.name }} <span class="text-[var(--text-secondary)]">({{ agent.slug }})</span></span>
        </label>
        <p
          v-if="!agents.length"
          class="text-sm text-[var(--text-secondary)]"
        >
          No agents are available to select.
        </p>
      </div>
      <button
        type="button"
        :disabled="busy || agentsLoading || (!allowAllAgents && (!!agentsError || !selectedAgentIds.length))"
        class="rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-sm text-[var(--text-primary)] disabled:opacity-60"
        @click="saveAllowedAgents"
      >
        Save agent access
      </button>
    </fieldset>
    <div class="flex flex-wrap items-center gap-3">
      <button
        type="submit"
        :disabled="busy"
        class="rounded-lg bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {{ busy ? 'Working…' : 'Save keys' }}
      </button>
      <button
        v-if="settings?.staging.connected || settings?.production.connected"
        type="button"
        :disabled="busy"
        class="rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-sm text-[var(--text-primary)] disabled:opacity-60"
        @click="disconnect"
      >
        Disconnect Clerk
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';

import type { ClerkSettings } from '@pkg/agent/integrations/clerk/ClerkClient';
import type { ClerkEnvironment } from '@pkg/agent/integrations/clerk/ClerkEndpoints';
import type { ClerkSectionOutcomes, ClerkSettingsResult } from '@pkg/main/ClerkSettingsService';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const emit = defineEmits<{ changed: [connected: boolean] }>();
const sections = [
  { id: 'staging', label: 'Staging', publishablePrefix: 'pk_test_…', secretPrefix: 'sk_test_…' },
  { id: 'production', label: 'Production', publishablePrefix: 'pk_live_…', secretPrefix: 'sk_live_…' },
] as const;
const freshKeys = () => ({ staging: { publishable: '', secret: '' }, production: { publishable: '', secret: '' } });
const keys = ref(freshKeys());
const settings = ref<ClerkSettings>();
const busy = ref(false);
const errors = ref<string[]>([]);
const sectionErrors = ref<Partial<Record<ClerkEnvironment, string>>>({});
const notice = ref('');
const banner = ref<HTMLElement>();
const agents = ref<{ slug: string; name: string }[]>([]);
const agentsLoading = ref(true);
const agentsError = ref('');
const allowAllAgents = ref(true);
const selectedAgentIds = ref<string[]>([]);

function labelOf(id: ClerkEnvironment) {
  return sections.find(section => section.id === id)?.label ?? id;
}

/** Typed keys are cleared only for sections the Vault confirmed; anything that failed stays for correction. */
function clearConfirmed(ids: readonly ClerkEnvironment[]) {
  for (const id of ids) keys.value[id] = { publishable: '', secret: '' };
}

async function perform(
  operation: () => Promise<ClerkSettingsResult>,
  successMessage: (outcomes?: ClerkSectionOutcomes) => string,
  clearOnSuccess: readonly ClerkEnvironment[] = [],
) {
  busy.value = true;
  errors.value = [];
  sectionErrors.value = {};
  notice.value = '';
  try {
    const result = await operation();
    if (result.settings) {
      settings.value = result.settings;
      emit('changed', result.settings.staging.connected || result.settings.production.connected);
    }
    if (Array.isArray(result.allowedAgentIds)) {
      selectedAgentIds.value = [...result.allowedAgentIds];
      allowAllAgents.value = result.allowedAgentIds.length === 0;
    }
    const outcomes = result.sections ?? {};
    const saved = sections.map(section => section.id).filter(id => outcomes[id]?.saved);
    clearConfirmed(result.success ? clearOnSuccess : saved);
    if (result.success) {
      notice.value = successMessage(outcomes);
      return;
    }
    for (const id of sections.map(section => section.id)) {
      const outcome = outcomes[id];
      if (outcome && !outcome.saved) sectionErrors.value[id] = outcome.error;
    }
    errors.value = Object.values(sectionErrors.value).length ? Object.values(sectionErrors.value) as string[] : [result.error];
    if (saved.length) notice.value = savedMessage(saved);
  } catch {
    errors.value = ['Clerk settings are unavailable. Unlock the Vault and try again.'];
  } finally {
    busy.value = false;
  }
  if (errors.value.length) {
    await nextTick();
    banner.value?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }
}

function savedMessage(ids: readonly ClerkEnvironment[]) {
  return `${ ids.map(labelOf).join(' and ') } saved and connected.`;
}

async function save() {
  const values: Record<string, string> = {};
  const submitted: ClerkEnvironment[] = [];
  for (const { id } of sections) {
    const pair = keys.value[id];
    if (!pair.publishable.trim() && !pair.secret.trim()) continue;
    values[`${ id }_publishable_key`] = pair.publishable;
    values[`${ id }_secret_key`] = pair.secret;
    submitted.push(id);
  }
  await perform(() => ipcRenderer.invoke('clerk:settings:save', values), () => savedMessage(submitted), submitted);
}

async function loadAgents() {
  agentsLoading.value = true;
  agentsError.value = '';
  try {
    const definitions = await ipcRenderer.invoke('agent-definitions:list', { strict: true });
    if (!Array.isArray(definitions)) throw new Error('Agent list is unavailable.');
    agents.value = definitions
      .filter(agent => typeof agent.slug === 'string' && typeof agent.name === 'string')
      .map(agent => ({ slug: agent.slug, name: agent.name }));
  } catch {
    agentsError.value = 'Couldn’t load the agent list. Try again before restricting access.';
  } finally {
    agentsLoading.value = false;
  }
}

async function saveAllowedAgents() {
  if (!allowAllAgents.value && (agentsError.value || !selectedAgentIds.value.length)) {
    errors.value = [agentsError.value || 'Choose at least one agent, or allow all agents.'];
    return;
  }
  const allowedAgentIds = allowAllAgents.value ? [] : [...new Set(selectedAgentIds.value)].sort();
  await perform(
    () => ipcRenderer.invoke('clerk:settings:save', { allowedAgentIds }),
    () => 'Clerk agent access saved.',
  );
}

function disconnectSection(id: ClerkEnvironment) {
  return perform(() => ipcRenderer.invoke('clerk:settings:save', {
    [`${ id }_publishable_key`]: '', [`${ id }_secret_key`]: '',
  }), () => `${ labelOf(id) } disconnected.`, [id]);
}

function disconnect() {
  return perform(() => ipcRenderer.invoke('clerk:settings:disconnect'), () => 'Clerk disconnected.', sections.map(section => section.id));
}

onMounted(async() => {
  await Promise.all([
    perform(() => ipcRenderer.invoke('clerk:settings:load'), () => ''),
    loadAgents(),
  ]);
});
</script>
