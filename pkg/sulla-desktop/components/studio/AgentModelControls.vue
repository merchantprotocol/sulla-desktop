<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';

import { CLASS_LABELS, modelName, providerName, resolveChoice } from '../settings/sections/modelRouting/routingLogic';

import type { ModelCandidate } from '@pkg/agent/languagemodels/modelRouter';
import { MODEL_CLASSES, type AgentModelChoice, type ModelRoutingState } from '@pkg/agent/languagemodels/modelRoutingTypes';

const props = defineProps<{ modelValue: AgentModelChoice; baseChoice: AgentModelChoice; fallbacks: ModelCandidate[]; state: ModelRoutingState | null }>();
const emit = defineEmits<{ (event: 'update:modelValue', choice: AgentModelChoice): void; (event: 'update:fallbacks', candidates: ModelCandidate[]): void }>();
const pin = computed(() => props.modelValue.mode === 'pin' ? props.modelValue : null);
const providers = computed(() => {
  const connected = (props.state?.providers ?? []).filter(provider => provider.connected && ['codex', 'claude-code', 'grok'].includes(provider.id));
  const retainedIds = new Set([
    ...(pin.value ? [pin.value.provider] : []),
    ...props.fallbacks.map(candidate => candidate.provider),
  ]);
  const retained = (props.state?.providers ?? []).filter(provider => retainedIds.has(provider.id));
  return [...connected, ...retained.filter(provider => !connected.some(row => row.id === provider.id))];
});
const subscriptionPin = computed(() => !!pin.value && ['codex', 'claude-code', 'grok'].includes(pin.value.provider));
const fallbackProviders = computed(() => providers.value.filter(provider => ['codex', 'claude-code', 'grok'].includes(provider.id)));
const current = computed(() => props.state ? resolveChoice(props.state, props.modelValue) : null);
function models(provider: string, selected = '') {
  const rows = props.state?.providers.find(item => item.id === provider)?.models ?? [];
  return selected && !rows.some(row => row.id === selected) ? [{ id: selected, label: `${ selected } · not listed` }, ...rows] : rows;
}
function efforts(provider: string, model: string) { return props.state?.providers.find(item => item.id === provider)?.models.find(item => item.id === model)?.efforts ?? [] }
function base(value: string) { emit('update:modelValue', value === 'list' ? { mode: 'list' } : { mode: 'class', class: value as typeof MODEL_CLASSES[number] }) }
function toggle() {
  if (pin.value) {
    // Fallbacks belong to a pinned first choice; unpinning hides their editor, so clear them visibly here.
    emit('update:modelValue', props.baseChoice.mode === 'pin' ? { mode: 'list' } : props.baseChoice);
    if (props.fallbacks.length) emit('update:fallbacks', []);
    return;
  }
  const provider = providers.value[0]; const model = provider?.models[0];
  if (provider && model) emit('update:modelValue', { mode: 'pin', provider: provider.id, model: model.id });
}
function selectProvider(provider: string) { emit('update:modelValue', { mode: 'pin', provider, model: models(provider)[0]?.id ?? '' }) }
function selectModel(model: string) { if (pin.value) emit('update:modelValue', { mode: 'pin', provider: pin.value.provider, model }); }
function selectEffort(effort: string) { if (pin.value) emit('update:modelValue', { mode: 'pin', provider: pin.value.provider, model: pin.value.model, ...(effort ? { effort } : {}) }); }
function updateFallback(index: number, patch: Partial<ModelCandidate>) { emit('update:fallbacks', props.fallbacks.map((row, i) => i === index ? { ...row, ...patch } : { ...row })) }
function add() { const provider = fallbackProviders.value[0]; const model = provider?.models[0]; if (provider && model) emit('update:fallbacks', [...props.fallbacks, { provider: provider.id, model: model.id }]); }
function move(index: number, delta: number) { const rows = [...props.fallbacks]; [rows[index], rows[index + delta]] = [rows[index + delta], rows[index]]; emit('update:fallbacks', rows) }
</script>
<template>
  <div class="mc">
    <div class="mc-set">
      <div class="mc-l">
        <b>Shared defaults</b><small>Use the Agents list or a model class from AI Models.</small><p v-if="!pin && current">
          Right now: {{ current.model }} {{ current.text }}
        </p>
      </div>
      <select
        :value="modelValue.mode === 'class' ? modelValue.class : baseChoice.mode === 'class' ? baseChoice.class : 'list'"
        class="mc-sel"
        aria-label="Model class"
        :disabled="!!pin"
        @change="base(($event.target as HTMLSelectElement).value)"
      >
        <option value="list">
          Agents list (default)
        </option><option
          v-for="modelClass in MODEL_CLASSES"
          :key="modelClass"
          :value="modelClass"
        >
          Class: {{ CLASS_LABELS[modelClass] }}
        </option>
      </select>
    </div>
    <div class="mc-set">
      <div class="mc-l">
        <b>Choose a specific model</b><small>Set the version and effort for this agent. Running work keeps its launch settings.</small>
      </div>
      <button
        type="button"
        class="mc-tog"
        :class="{ on: !!pin }"
        role="switch"
        :aria-checked="!!pin"
        aria-label="Pin a specific model"
        :disabled="!pin && !providers.length"
        @click="toggle"
      />
    </div>
    <template v-if="pin">
      <div class="mc-set">
        <div class="mc-l">
          <b>Model</b><small>First choice for this agent.</small>
        </div>
        <div class="mc-c">
          <select
            :value="pin.provider"
            class="mc-sel"
            aria-label="Pinned provider"
            @change="selectProvider(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-if="!providers.some(provider => provider.id === pin!.provider)"
              :value="pin.provider"
            >
              {{ pin.provider }} · not listed
            </option><option
              v-for="provider in providers"
              :key="provider.id"
              :value="provider.id"
            >
              {{ providerName(state, provider.id) }}
            </option>
          </select>
          <select
            :value="pin.model"
            class="mc-sel"
            aria-label="Pinned model"
            @change="selectModel(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="model in models(pin.provider, pin.model)"
              :key="model.id"
              :value="model.id"
            >
              {{ state ? modelName(state, pin.provider, model.id) : model.label }}
            </option>
          </select>
        </div>
      </div>
      <div class="mc-set">
        <div class="mc-l">
          <b>Effort</b><small>Provider default leaves the model’s own default in place.</small>
        </div>
        <select
          v-if="efforts(pin.provider, pin.model).length || pin.effort"
          :value="pin.effort ?? ''"
          class="mc-sel"
          aria-label="Reasoning effort"
          @change="selectEffort(($event.target as HTMLSelectElement).value)"
        >
          <option value="">
            Provider default
          </option><option
            v-if="pin.effort && !efforts(pin.provider, pin.model).some(level => level.id === pin!.effort)"
            :value="pin.effort"
          >
            {{ pin.effort }} · not listed
          </option><option
            v-for="level in efforts(pin.provider, pin.model)"
            :key="level.id"
            :value="level.id"
          >
            {{ level.id }}
          </option>
        </select>
        <span
          v-else
          class="mc-muted"
        >No effort setting for this model</span>
      </div>
      <details
        v-if="subscriptionPin || fallbacks.length"
        class="mc-fallbacks"
      >
        <summary>Fallback models · {{ fallbacks.length }}</summary>
        <p>Try these in order if the first choice is unavailable or out of subscription usage.</p>
        <p
          v-if="!subscriptionPin"
          role="alert"
        >
          Choose Claude Code, OpenAI Codex, or the Grok OAuth subscription before saving fallback models.
        </p>
        <div
          v-for="(row, index) in fallbacks"
          :key="index"
          class="mc-fallback"
        >
          <strong>{{ index + 1 }}</strong>
          <select
            :value="row.provider"
            :aria-label="`Fallback provider ${index + 1}`"
            @change="updateFallback(index, { provider: ($event.target as HTMLSelectElement).value, model: models(($event.target as HTMLSelectElement).value)[0]?.id ?? '', effort: undefined })"
          >
            <option
              v-if="!fallbackProviders.some(provider => provider.id === row.provider)"
              :value="row.provider"
            >
              {{ row.provider }} · not listed
            </option>
            <option
              v-for="provider in fallbackProviders"
              :key="provider.id"
              :value="provider.id"
            >
              {{ provider.name }}
            </option>
          </select>
          <select
            :value="row.model"
            :aria-label="`Fallback model ${index + 1}`"
            @change="updateFallback(index, { model: ($event.target as HTMLSelectElement).value, effort: undefined })"
          >
            <option
              v-for="model in models(row.provider, row.model)"
              :key="model.id"
              :value="model.id"
            >
              {{ model.label }}
            </option>
          </select>
          <select
            v-if="efforts(row.provider, row.model).length || row.effort"
            :value="row.effort ?? ''"
            :aria-label="`Fallback effort ${index + 1}`"
            @change="updateFallback(index, { effort: ($event.target as HTMLSelectElement).value || undefined })"
          >
            <option value="">
              Provider default
            </option><option
              v-if="row.effort && !efforts(row.provider, row.model).some(level => level.id === row.effort)"
              :value="row.effort"
            >
              {{ row.effort }} · not listed
            </option><option
              v-for="level in efforts(row.provider, row.model)"
              :key="level.id"
              :value="level.id"
            >
              {{ level.id }}
            </option>
          </select>
          <button
            type="button"
            :aria-label="`Move fallback ${index + 1} up`"
            :disabled="index === 0"
            @click="move(index, -1)"
          >
            ↑
          </button><button
            type="button"
            :aria-label="`Move fallback ${index + 1} down`"
            :disabled="index === fallbacks.length - 1"
            @click="move(index, 1)"
          >
            ↓
          </button><button
            type="button"
            :aria-label="`Remove fallback ${index + 1}`"
            @click="emit('update:fallbacks', fallbacks.filter((_, i) => i !== index))"
          >
            Remove
          </button>
        </div>
        <button
          type="button"
          class="btn sm"
          :disabled="!subscriptionPin || !fallbackProviders.length || fallbacks.length >= 9"
          @click="add"
        >
          Add fallback
        </button>
      </details>
      <p
        v-if="!fallbacks.length"
        class="mc-note"
      >
        No fallback selected. This agent waits if its selected provider is unavailable.
      </p>
    </template>
    <p class="mc-note">
      Model settings change how this agent runs. Its instructions, tools and workflow stay the same.
    </p>
  </div>
</template>
<style scoped>
.mc{overflow:hidden;border:1px solid var(--uc-line);border-radius:10px;background:var(--uc-card)}.mc-set{display:flex;align-items:center;gap:24px;padding:13px 16px;border-top:1px solid var(--uc-line)}.mc-set:first-child{border-top:0}.mc-l{flex:1;min-width:0}.mc-l b{display:block;color:var(--uc-text);font-weight:600}.mc-l small,.mc-l p,.mc-muted{display:block;margin-top:2px;color:var(--uc-dim);font-size:12px}.mc-c{display:flex;flex:none;flex-wrap:wrap;justify-content:flex-end;gap:8px}.mc select{width:auto;max-width:100%;min-width:150px;padding:6px 10px;color:var(--uc-text);background:var(--uc-paper);border:1px solid var(--uc-line-strong);border-radius:7px;font:inherit}.mc select:disabled{opacity:.5}.mc-tog{position:relative;flex:none;width:34px;height:20px;padding:0;border:0;border-radius:999px;background:var(--uc-line-strong);cursor:pointer}.mc-tog::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--bg-surface);box-shadow:0 1px 2px rgb(0 0 0 / 25%)}.mc-tog.on{background:var(--uc-accent)}.mc-tog.on::after{transform:translateX(14px)}.mc :is(button,select,summary):focus-visible{outline:2px solid var(--uc-accent);outline-offset:2px}.mc-note,.mc-fallbacks{padding:12px 16px;border-top:1px solid var(--uc-line);color:var(--uc-muted);font-size:12px}.mc-fallbacks summary{cursor:pointer}.mc-fallback{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0}.mc-fallback select{min-width:120px}.mc-fallback button{font:inherit;padding:6px;background:transparent;color:inherit;border:1px solid var(--uc-line-strong);border-radius:6px}@media(max-width:720px){.mc-set{flex-direction:column;align-items:stretch;gap:10px}.mc-c{justify-content:flex-start}}
</style>
