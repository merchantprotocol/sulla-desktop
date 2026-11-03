<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
import { ref } from 'vue';
import { MODEL_CLASSES, type ClassModel, type ModelClass, type ModelRoutingState } from '@pkg/agent/languagemodels/modelRoutingTypes';
import { CLASS_FALLBACK, CLASS_LABELS, moveItem, orderedClassModels } from './routingLogic';
const props = defineProps<{ state: ModelRoutingState }>();
const emit = defineEmits<{ (e: 'models', modelClass: ModelClass, models: ClassModel[]): void; (e: 'follow', modelClass: ModelClass, value: boolean): void; (e: 'reset', modelClass?: ModelClass): void }>();
const open = ref<ModelClass | null>('frontier'); const adding = ref<ModelClass | null>(null);
function provider(id: string) { return props.state.providers.find(p => p.id === id); }
function options(c: ModelClass) { return props.state.providers.filter(p => p.connected && (c !== 'local' || p.local)).flatMap(p => p.models.filter(m => !props.state.classes[c].some(x => x.provider === p.id && x.model === m.id)).map(m => ({ provider: p, model: m }))); }
</script>
<template><section class="route-card classes"><header><div><h2>Models in each class</h2><p>Define what Frontier, Standard, Fast, Coding and Local mean. Models are tried top to bottom.</p></div><button class="link" @click="emit('reset')">Reset to recommended</button></header>
  <div v-for="c in MODEL_CLASSES" :key="c" class="class-row"><button class="class-head" @click="open = open === c ? null : c"><span>{{ open === c ? '▾' : '▸' }}</span><b>{{ CLASS_LABELS[c] }}</b><small v-if="open !== c">{{ orderedClassModels(state, c).slice(0, 3).map(m => `${provider(m.provider)?.name}: ${m.model}`).join(' → ') || (CLASS_FALLBACK[c] ? `Empty · falls back to ${CLASS_LABELS[CLASS_FALLBACK[c]!]}` : 'Empty · no fallback') }}</small></button>
    <div v-if="open === c" class="class-body"><div class="order-switch"><button :class="{ on: state.followProviderOrder[c] }" @click="emit('follow', c, true)">Follow provider order</button><button :class="{ on: !state.followProviderOrder[c] }" @click="emit('follow', c, false)">Custom order</button><span>{{ state.followProviderOrder[c] ? 'Sorted by your Agents list.' : 'Your order.' }}</span></div>
      <p v-if="!state.classes[c].length" class="empty">No models. {{ CLASS_FALLBACK[c] ? `Agents asking for ${CLASS_LABELS[c]} fall back to ${CLASS_LABELS[CLASS_FALLBACK[c]!]}.` : 'Local requests cannot fall back online.' }}</p>
      <div v-for="(m, i) in orderedClassModels(state, c)" :key="`${m.provider}-${m.model}`" class="model-row"><span class="rank">{{ i + 1 }}</span><b>{{ provider(m.provider)?.name ?? m.provider }}</b><code>{{ m.model }}</code><button :disabled="i === 0 || state.followProviderOrder[c]" @click="emit('models', c, moveItem(state.classes[c], i, i - 1))">↑</button><button :disabled="i === state.classes[c].length - 1 || state.followProviderOrder[c]" @click="emit('models', c, moveItem(state.classes[c], i, i + 1))">↓</button><button @click="emit('models', c, state.classes[c].filter(x => x !== m))">×</button></div>
      <button class="btn sm" @click="adding = adding === c ? null : c">+ Add model</button><div v-if="adding === c" class="picker model-picker"><button v-for="x in options(c)" :key="`${x.provider.id}-${x.model.id}`" @click="emit('models', c, [...state.classes[c], { provider: x.provider.id, model: x.model.id }])"><b>{{ x.provider.name }}</b> · {{ x.model.label }} <span>Add</span></button></div><button class="link reset-one" @click="emit('reset', c)">Reset {{ CLASS_LABELS[c] }}</button>
    </div></div>
</section></template>
