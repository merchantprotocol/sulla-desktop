<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <section class="launch-preview" aria-label="Next launch">
    <strong>{{ heading }}</strong>
    <p>{{ preview.reason }}</p>
    <ol v-if="preview.candidates.length">
      <li v-for="(candidate, index) in preview.candidates" :key="JSON.stringify(candidate)">
        <small>{{ index ? 'Fallback ' + index : preview.status === 'deferred' ? 'First eligible' : 'First choice' }}</small>
        <span>{{ candidate.model }} · {{ previewEffort(candidate, providers) }}</span>
        <small>{{ providers?.find(row => row.id === candidate.provider)?.name ?? candidate.provider }}</small>
      </li>
    </ol>
    <small v-if="preview.candidates.length === 1">No other eligible fallback.</small>
    <small v-if="preview.launchRequestPolicy">{{ preview.launchRequestPolicy }}</small>
    <details v-if="preview.skipped?.length">
      <summary>Skipped choices · {{ preview.skipped.length }}</summary>
      <ul><li v-for="row in preview.skipped" :key="JSON.stringify(row.candidate)">{{ row.candidate.model }} · {{ row.reason }}</li></ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { previewEffort, type ModelLaunchPreview } from '../shared/modelLaunchPreview';
import type { RoutingProviderInfo } from '../agent/languagemodels/modelRoutingTypes';

const props = defineProps<{ preview: ModelLaunchPreview; providers?: RoutingProviderInfo[] }>();
const heading = computed(() => ({ ready: 'Next launch', waiting: 'Waiting to launch', blocked: 'Launch blocked', deferred: 'Decided at handoff' })[props.preview.status]);
</script>

<style scoped>
.launch-preview { display: grid; gap: .4rem; min-width: 0; overflow-wrap: anywhere; }
.launch-preview strong { font-size: .85rem; }
.launch-preview p, .launch-preview ol { margin: 0; }
.launch-preview p, .launch-preview small { color: var(--text-muted); }
.launch-preview ol { list-style: none; padding: 0; display: grid; gap: .35rem; }
.launch-preview li { display: flex; align-items: baseline; flex-wrap: wrap; gap: .2rem .5rem; border-left: 2px solid var(--border-default); padding-inline-start: .5rem; }
.launch-preview li:first-child { border-color: var(--accent); }
</style>
