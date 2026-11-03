<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ModelClass, ModelRoutingState, RoutingRow } from '@pkg/agent/languagemodels/modelRoutingTypes';
import { openMainTab } from '@pkg/composables/preferences/openInMain';
import { CLASS_LABELS, modelsForProvider, moveItem, resolvedModel } from './routingLogic';
const props = defineProps<{ title: string; subtitle: string; state: ModelRoutingState; rows: RoutingRow[] }>();
const emit = defineEmits<{ (e: 'update', rows: RoutingRow[]): void; (e: 'reset'): void }>();
const adding = ref(false); const dragIndex = ref<number | null>(null);
const disconnected = computed(() => props.state.providers.filter(p => !p.connected));
function provider(id: string) { return props.state.providers.find(p => p.id === id); }
function update(index: number, patch: Partial<RoutingRow>) { const next = props.rows.map((r, i) => i === index ? { ...r, ...patch } : r); emit('update', next); }
function move(from: number, to: number) { if (to >= 0 && to < props.rows.length) emit('update', moveItem(props.rows, from, to)); }
function add(providerId: string, modelClass: ModelClass) { if (!props.rows.some(r => r.provider === providerId && r.class === modelClass)) emit('update', [...props.rows, { provider: providerId, class: modelClass, enabled: true }]); }
function status(row: RoutingRow) { const p = provider(row.provider); if (!row.enabled) return 'Skipped'; if (!resolvedModel(props.state, row)) return `No ${ CLASS_LABELS[row.class] } model`; if (p?.status === 'cooling') return `Cooling until ${ new Date(p.coolingUntil ?? '').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }`; if (p?.status === 'error') return 'Error'; return p?.connected ? 'Ready' : 'Not connected'; }
</script>
<template>
  <section class="route-card">
    <header><div><h2>{{ title }}</h2><p>{{ subtitle }}</p></div><button class="link" type="button" @click="emit('reset')">Reset to default</button></header>
    <p v-if="state.providers.filter(p => p.connected).length === 1" class="single-hint">You have one provider connected. Add another in Integrations for automatic fallback.</p>
    <ol class="provider-list">
      <li v-for="(row, i) in rows" :key="`${row.provider}-${row.class}`" :class="{ skipped: !row.enabled }" draggable="true" @dragstart="dragIndex = i" @dragover.prevent @drop="dragIndex !== null && move(dragIndex, i)">
        <button class="grip" title="Drag to reorder. Use arrow keys to move." @keydown.up.prevent="move(i, i - 1)" @keydown.down.prevent="move(i, i + 1)">⋮⋮</button><span class="rank">{{ i + 1 }}</span>
        <div class="identity"><b>{{ provider(row.provider)?.name ?? row.provider }}</b><small>{{ provider(row.provider)?.subscription ? 'Subscription · shared usage limits' : provider(row.provider)?.local ? 'Runs on this Mac' : 'Online provider' }}</small></div>
        <div class="resolution"><select :value="row.class" :aria-label="`${provider(row.provider)?.name} model class`" @change="update(i, { class: ($event.target as HTMLSelectElement).value as ModelClass })"><option v-for="c in modelsForProvider(state, provider(row.provider)!)" :key="c" :value="c">{{ CLASS_LABELS[c] }}</option><option v-if="!modelsForProvider(state, provider(row.provider)!).includes(row.class)" :value="row.class">{{ CLASS_LABELS[row.class] }} (no models)</option></select><small>→ {{ resolvedModel(state, row)?.model ?? 'no model' }}</small></div>
        <span class="status" :data-status="provider(row.provider)?.status">{{ status(row) }}</span>
        <div class="row-actions"><button title="Move up" :disabled="i === 0" @click="move(i, i - 1)">↑</button><button title="Move down" :disabled="i === rows.length - 1" @click="move(i, i + 1)">↓</button><button title="Remove" @click="emit('update', rows.filter((_, n) => n !== i))">×</button></div>
        <label class="switch"><input type="checkbox" :checked="row.enabled" @change="update(i, { enabled: ($event.target as HTMLInputElement).checked })"><span /> <em>{{ row.enabled ? 'On' : 'Skip' }}</em></label>
      </li>
    </ol>
    <div class="add-wrap"><button class="btn sm" @click="adding = !adding">+ Add provider</button><div v-if="adding" class="picker"><template v-for="p in state.providers.filter(x => x.connected)" :key="p.id"><b>{{ p.name }}</b><button v-for="c in modelsForProvider(state, p)" :key="c" :disabled="rows.some(r => r.provider === p.id && r.class === c)" @click="add(p.id, c)">{{ CLASS_LABELS[c] }} <small>→ {{ state.classes[c].find(m => m.provider === p.id)?.model }}</small><span>{{ rows.some(r => r.provider === p.id && r.class === c) ? 'In list' : 'Add' }}</span></button></template></div></div>
    <div v-if="disconnected.length" class="not-connected"><b>Not connected</b><span v-for="p in disconnected" :key="p.id">{{ p.name }} <button class="link" @click="openMainTab('integrations')">Connect</button></span></div>
  </section>
</template>
