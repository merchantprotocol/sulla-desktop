<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
/** The model menu under a ledger line: search, the provider's models with tags, and where the list comes from. */
import { chipHealth, isNewModel, upgradeFor } from './laneLogic';
import { providerName } from './routingLogic';

import { isAutoEntry, isBlocked } from '@pkg/agent/languagemodels/modelCatalogRules';
import type { ClassModel, ModelRoutingState, NeverUsePair } from '@pkg/agent/languagemodels/modelRoutingTypes';

const props = defineProps<{
  state:  ModelRoutingState;
  view:   ModelRoutingState;
  never:  NeverUsePair[];
  m:      ClassModel;
  models: { id: string; label: string }[];
  query:  string;
}>();
const emit = defineEmits<{ (e: 'update:query', q: string): void; (e: 'pick', model: string): void }>();
const MENU_CAP = 60;
const modelsOf = (p: string) => props.state.providers.find(x => x.id === p)?.models ?? [];
const canCheck = (p: string) => modelsOf(p).some(m => !m.unverified && !isAutoEntry(p, m.id));
</script>

<template>
  <div
    class="ld-menu"
    role="dialog"
    :aria-label="`Choose the ${providerName(state, m.provider)} model`"
  >
    <div class="ld-menu-q">
      <input
        :value="query"
        type="search"
        class="inp sm"
        :placeholder="`Search ${modelsOf(m.provider).length} ${providerName(state, m.provider)} models`"
        aria-label="Search models"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      >
    </div>
    <div
      class="ld-menu-list"
      role="listbox"
    >
      <div
        v-if="chipHealth(view, m) === 'unlisted' && !query"
        class="ld-opt gone"
      >
        <s>{{ m.model }}</s><span class="ld-tag warn">No longer listed</span>
      </div>
      <button
        v-for="x in models.slice(0, MENU_CAP)"
        :key="x.id"
        type="button"
        role="option"
        class="ld-opt"
        :class="{ cur: !m.rule && m.model === x.id }"
        :aria-selected="!m.rule && m.model === x.id"
        :disabled="isBlocked(never, m.provider, x.id)"
        @click="emit('pick', x.id)"
      >
        <span class="ld-opt-n">{{ x.label || x.id }}</span>
        <span
          v-if="isAutoEntry(m.provider, x.id)"
          class="ld-tag"
        >The provider chooses</span>
        <span
          v-if="isNewModel(state, m.provider, x.id)"
          class="ld-tag new"
        >New</span>
        <span
          v-if="upgradeFor(view, m) === x.id && chipHealth(view, m) === 'unlisted'"
          class="ld-tag warn"
        >Suggested</span>
        <span
          v-if="isBlocked(never, m.provider, x.id)"
          class="ld-tag"
        >Never use</span>
      </button>
      <p
        v-if="models.length > MENU_CAP"
        class="ld-menu-note"
      >
        Showing {{ MENU_CAP }} of {{ models.length }}. Type to narrow.
      </p>
      <p
        v-if="!models.length"
        class="ld-menu-note"
      >
        No model matches.
      </p>
    </div>
    <p class="ld-menu-foot">
      {{ canCheck(m.provider) ? `Live list from ${providerName(state, m.provider)}, in its own order.` : `${providerName(state, m.provider)} publishes no model list for your sign-in, so this is Sulla's built-in list.` }}
    </p>
  </div>
</template>

<style scoped src="./RoleLedger.css"></style>
