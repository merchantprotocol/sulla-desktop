<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
/** The never-use list: its disclosure, the blocked pairs, and the builder that adds one. */
import { computed, ref, watch } from 'vue';

import { effortLabel } from './laneLogic';
import { LedgerText } from './ledgerText';
import { providerName } from './routingLogic';

import { isAutoEntry } from '@pkg/agent/languagemodels/modelCatalogRules';
import type { ModelRoutingState, NeverUsePair } from '@pkg/agent/languagemodels/modelRoutingTypes';

const props = defineProps<{ state: ModelRoutingState; never: NeverUsePair[]; open: boolean }>();
const emit = defineEmits<{ (e: 'toggle'): void; (e: 'add', pair: NeverUsePair): void; (e: 'remove', pair: NeverUsePair): void }>();

const modelsOf = (p: string) => props.state.providers.find(x => x.id === p)?.models ?? [];
const pairText = (b: NeverUsePair) => LedgerText.pairText(props.state, b);
const pairProvider = ref('');
const pairModel = ref('');
const pairEffort = ref('any');
const pairProviders = computed(() => props.state.providers.filter(p => p.connected && p.models.length));
const pairModels = computed(() => modelsOf(pairProvider.value).filter(m => !isAutoEntry(pairProvider.value, m.id)));
const pairLevels = computed(() => modelsOf(pairProvider.value).find(m => m.id === pairModel.value)?.efforts ?? []);
watch(pairProviders, list => { if (!pairProvider.value && list[0]) pairProvider.value = list[0].id; }, { immediate: true });
watch(pairProvider, () => { pairModel.value = pairModels.value[0]?.id ?? ''; pairEffort.value = 'any' });
function addBuiltPair() { if (pairProvider.value && pairModel.value) emit('add', { provider: pairProvider.value, model: pairModel.value, effort: pairEffort.value }); }
</script>

<template>
  <button
    type="button"
    class="ld-disc"
    :aria-expanded="open"
    @click="emit('toggle')"
  >
    <svg
      class="ld-i ld-chev"
      viewBox="0 0 16 16"
      aria-hidden="true"
    ><path d="M6 3.5 10.5 8 6 12.5" /></svg>
    <b>Never-use list</b>
    <span class="ld-dim">{{ never.length ? `${never.length} model and effort ${never.length === 1 ? 'pair' : 'pairs'}` : 'Nothing blocked' }}</span>
  </button>
  <div
    v-if="open"
    class="ld-never"
  >
    <div class="ld-row-wrap">
      <span
        v-for="b in never"
        :key="`${b.provider}/${b.model}/${b.effort}`"
        class="ld-chip"
      >{{ pairText(b) }} <span class="ld-dim">{{ providerName(state, b.provider) }}</span><button
        type="button"
        :aria-label="`Allow ${pairText(b)} again`"
        @click="emit('remove', b)"
      >×</button></span>
      <span
        v-if="!never.length"
        class="ld-dim"
      >No pairs yet.</span>
    </div>
    <form
      v-if="pairProviders.length"
      class="ld-row-wrap ld-pair"
      @submit.prevent="addBuiltPair"
    >
      <span class="ld-dim">Never use</span>
      <select
        v-model="pairProvider"
        class="sel sm"
        aria-label="Provider"
      >
        <option
          v-for="p in pairProviders"
          :key="p.id"
          :value="p.id"
        >
          {{ providerName(state, p.id) }}
        </option>
      </select>
      <select
        v-model="pairModel"
        class="sel sm"
        aria-label="Model"
      >
        <option
          v-for="x in pairModels"
          :key="x.id"
          :value="x.id"
        >
          {{ x.label || x.id }}
        </option>
      </select>
      <span class="ld-dim">at</span>
      <select
        v-model="pairEffort"
        class="sel sm"
        aria-label="Effort"
      >
        <option value="any">
          Any effort
        </option>
        <option
          v-for="l in pairLevels"
          :key="l.id"
          :value="l.id"
        >
          {{ effortLabel(l.id) }}
        </option>
      </select>
      <button
        type="submit"
        class="btn sm"
      >
        Add pair
      </button>
    </form>
    <p class="ld-dim">
      A role entry that would run a blocked pair is skipped. An entry left on Default counts as the model's default level.
    </p>
  </div>
</template>

<style scoped src="./RoleLedger.css"></style>
