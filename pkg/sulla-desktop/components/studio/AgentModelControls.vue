<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';

import { candidateKey, type AgentModelTiers, type ModelTier } from '@pkg/agent/languagemodels/agentModelTiers';
import type { ModelCandidate } from '@pkg/agent/languagemodels/modelRouter';
import { MODEL_CLASSES, type AgentModelChoice, type ModelClass, type ModelRoutingState, type RoutingProviderInfo } from '@pkg/agent/languagemodels/modelRoutingTypes';
import { previewEffort } from '@pkg/shared/modelLaunchPreview';
import { isSubscriptionAccess } from '@pkg/shared/providerAccess';
import { AGENT_EDITOR_WORKER_PROVIDERS } from '@pkg/shared/agentEditor';
import { CLASS_LABELS, choiceLabel } from '../settings/sections/modelRouting/routingLogic';

const props = withDefaults(defineProps<{
  modelValue: AgentModelChoice;
  tiers: AgentModelTiers | null;
  state: ModelRoutingState;
  source: string;
  sharedChoiceReadonly?: boolean;
}>(), { sharedChoiceReadonly: false });
const emit = defineEmits<{ 'update:modelValue': [choice: AgentModelChoice]; 'update:tiers': [tiers: AgentModelTiers | null] }>();
const providers = computed(() => props.state.providers.filter(provider =>
  provider.connected && AGENT_EDITOR_WORKER_PROVIDERS.some(id => id === provider.id) &&
  (!provider.accessMethod || isSubscriptionAccess(provider.accessMethod)) && usableModels(provider).length,
));

function usableModels(provider?: RoutingProviderInfo) {
  return provider?.models.filter(row => !row.unverified) ?? [];
}
function models(provider: string) {
  return usableModels(providers.value.find(row => row.id === provider));
}
function efforts(provider: string, model: string) {
  return models(provider).find(row => row.id === model)?.efforts ?? [];
}

const available = computed(() => {
  const used = new Set(props.tiers?.tiers.flatMap(tier => tier.candidates.map(candidateKey)));
  for (const provider of providers.value) {
    for (const model of usableModels(provider)) {
      for (const effort of [undefined, ...(model.efforts?.map(row => row.id) ?? [])]) {
        const candidate = { provider: provider.id, model: model.id, ...(effort ? { effort } : {}) };
        if (!used.has(candidateKey(candidate))) return candidate;
      }
    }
  }
});

const valueOf = (event: Event) => (event.target as HTMLSelectElement).value;
function selectShared(value: string) {
  emit('update:modelValue', value === 'list' ? { mode: 'list' } : { mode: 'class', class: value as ModelClass });
}
function useShared() {
  emit('update:tiers', null);
  if (!props.sharedChoiceReadonly && props.modelValue.mode === 'pin') selectShared('list');
}
function updateTiers(tiers: ModelTier[]) {
  if (props.tiers) emit('update:tiers', { ...props.tiers, tiers });
}
function patchPolicy(patch: Pick<AgentModelTiers, 'allowLaunchOverride' | 'crossCompanyFallback'>) {
  if (props.tiers) emit('update:tiers', { ...props.tiers, ...patch });
}
function addTier() {
  if (!available.value) return;
  if (props.tiers) updateTiers([...props.tiers.tiers, { candidates: [available.value] }]);
  else {
    emit('update:tiers', { version: 1, tiers: [{ candidates: [available.value] }], crossCompanyFallback: true, allowLaunchOverride: 'listed' });
    if (props.modelValue.mode === 'pin') selectShared('list');
  }
}
function updateRows(index: number, candidates: ModelCandidate[]) {
  if (props.tiers) updateTiers(props.tiers.tiers.map((tier, i) => i === index ? { ...tier, candidates } : tier));
}
function selectProvider(tier: number, row: number, provider: string) {
  const model = models(provider)[0];
  if (model) patchRow(tier, row, { provider, model: model.id });
}
function patchRow(tier: number, index: number, replacement: ModelCandidate) {
  updateRows(tier, props.tiers!.tiers[tier].candidates.map((row, i) => i === index ? replacement : row));
}
function move<T>(rows: T[], index: number, delta: number) {
  const ordered = [...rows];
  [ordered[index], ordered[index + delta]] = [ordered[index + delta], ordered[index]];
  return ordered;
}
</script>

<template>
  <div class="model-tiers">
    <div class="setting">
      <div><strong>{{ source }}</strong><p v-if="!tiers && modelValue.mode === 'pin'">{{ choiceLabel(modelValue, state) }}</p></div>
      <button v-if="tiers || modelValue.mode === 'pin'" class="btn sm" type="button" @click="useShared">Use shared defaults</button>
      <span v-else-if="sharedChoiceReadonly" class="inherited-choice">{{ choiceLabel(modelValue, state) }}</span>
      <select v-else :value="modelValue.mode === 'class' ? modelValue.class : 'list'" aria-label="Shared model defaults" @change="selectShared(valueOf($event))">
        <option value="list">Agents list</option>
        <option v-for="modelClass in MODEL_CLASSES" :key="modelClass" :value="modelClass">{{ CLASS_LABELS[modelClass] }} class</option>
      </select>
    </div>
    <template v-if="tiers">
      <fieldset v-for="(tier, tierIndex) in tiers.tiers" :key="tierIndex">
        <legend>Tier {{ tierIndex + 1 }}</legend>
        <div v-for="(row, rowIndex) in tier.candidates" :key="rowIndex" class="candidate">
          <select :value="row.provider" :aria-label="`Tier ${tierIndex + 1}, model ${rowIndex + 1} provider`" @change="selectProvider(tierIndex, rowIndex, valueOf($event))">
            <option v-if="!providers.some(provider => provider.id === row.provider)" :value="row.provider" disabled>{{ row.provider }} · unavailable</option>
            <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
          </select>
          <select :value="row.model" :aria-label="`Tier ${tierIndex + 1}, model ${rowIndex + 1} version`" @change="patchRow(tierIndex, rowIndex, { provider: row.provider, model: valueOf($event) })">
            <option v-if="!models(row.provider).some(model => model.id === row.model)" :value="row.model" disabled>{{ row.model }} · unavailable</option>
            <option v-for="model in models(row.provider)" :key="model.id" :value="model.id">{{ model.label }}</option>
          </select>
          <select v-if="row.effort || efforts(row.provider, row.model).length" :value="row.effort ?? ''" :aria-label="`Tier ${tierIndex + 1}, model ${rowIndex + 1} effort`" @change="patchRow(tierIndex, rowIndex, { provider: row.provider, model: row.model, ...(valueOf($event) ? { effort: valueOf($event) } : {}) })">
            <option value="">Provider default</option>
            <option v-if="row.effort && !efforts(row.provider, row.model).some(level => level.id === row.effort)" :value="row.effort" disabled>{{ row.effort }} · unavailable</option>
            <option v-for="level in efforts(row.provider, row.model)" :key="level.id" :value="level.id">{{ previewEffort({ ...row, effort: level.id }) }}</option>
          </select>
          <div class="actions">
            <button class="btn sm" type="button" :aria-label="`Move model ${rowIndex + 1} up in tier ${tierIndex + 1}`" :disabled="rowIndex === 0" @click="updateRows(tierIndex, move(tier.candidates, rowIndex, -1))">↑</button>
            <button class="btn sm" type="button" :aria-label="`Move model ${rowIndex + 1} down in tier ${tierIndex + 1}`" :disabled="rowIndex === tier.candidates.length - 1" @click="updateRows(tierIndex, move(tier.candidates, rowIndex, 1))">↓</button>
            <button class="btn sm" type="button" :aria-label="`Remove model ${rowIndex + 1} in tier ${tierIndex + 1}`" :disabled="tier.candidates.length === 1" @click="updateRows(tierIndex, tier.candidates.filter((_, i) => i !== rowIndex))">Remove model</button>
          </div>
        </div>
        <div class="actions">
          <button class="btn sm" type="button" :disabled="tier.candidates.length >= 10 || !available" @click="available && updateRows(tierIndex, [...tier.candidates, available])">Add model</button>
          <button class="btn sm" type="button" :aria-label="`Move tier ${tierIndex + 1} up`" :disabled="tierIndex === 0" @click="updateTiers(move(tiers.tiers, tierIndex, -1))">↑</button>
          <button class="btn sm" type="button" :aria-label="`Move tier ${tierIndex + 1} down`" :disabled="tierIndex === tiers.tiers.length - 1" @click="updateTiers(move(tiers.tiers, tierIndex, 1))">↓</button>
          <button class="btn sm" type="button" :aria-label="`Remove tier ${tierIndex + 1}`" :disabled="tiers.tiers.length === 1" @click="updateTiers(tiers.tiers.filter((_, i) => i !== tierIndex))">Remove tier</button>
        </div>
      </fieldset>
    </template>
    <div class="setting">
      <button class="btn sm" type="button" :disabled="!available || (tiers?.tiers.length ?? 0) >= 10" @click="addTier">{{ tiers ? 'Add tier' : 'Set model tiers' }}</button>
      <small v-if="!providers.length">Connect a subscription and refresh its model catalog to add models.</small>
    </div>
    <div v-if="tiers" class="setting policy">
      <label class="policy-select">Launch override
        <select :value="tiers.allowLaunchOverride ?? 'listed'" @change="patchPolicy({ allowLaunchOverride: valueOf($event) as AgentModelTiers['allowLaunchOverride'] })">
          <option value="listed">Models in these tiers</option>
          <option value="never">Never</option>
          <option value="any">Models on approved subscriptions</option>
        </select>
      </label>
      <label class="policy-checkbox"><input type="checkbox" :checked="tiers.crossCompanyFallback !== false" @change="patchPolicy({ crossCompanyFallback: ($event.target as HTMLInputElement).checked })"> Allow fallback across companies</label>
    </div>
  </div>
</template>

<style scoped>
.model-tiers { display: grid; gap: .5rem; min-width: 0; container-type: inline-size; }
.setting, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: .45rem; min-width: 0; }
.setting { justify-content: space-between; }
.setting p, .setting small { margin: .2rem 0 0; color: var(--uc-dim); }
fieldset { display: grid; gap: .55rem; min-width: 0; padding: .65rem; border: 1px solid var(--uc-line-strong); border-radius: .5rem; }
legend { padding: 0 .2rem; font-weight: 600; }
.candidate { display: grid; grid-template-columns: minmax(0, 1fr); align-items: center; gap: .35rem; min-width: 0; }
@container (min-width: 34rem) {
  .candidate { grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr) minmax(0, 1fr); }
}
.candidate .actions { grid-column: 1 / -1; }
.candidate + .candidate { border-top: 1px solid var(--uc-line); padding-top: .4rem; }
select { min-width: 0; max-width: 100%; padding: .35rem; color: var(--uc-text); background: var(--uc-paper); border: 1px solid var(--uc-line-strong); border-radius: .35rem; font: inherit; }
.inherited-choice { color: var(--uc-muted); }
.policy { align-items: flex-start; }
.policy-select, .policy-checkbox { display: flex; align-items: center; flex-wrap: wrap; gap: .35rem; }
:where(button, select, input):focus-visible { outline: 2px solid var(--uc-accent); outline-offset: 2px; }
button {
  padding: .3rem .5rem;
  min-height: 1.75rem;
  color: var(--uc-text);
  background: var(--uc-paper);
  border: 1px solid var(--uc-line-strong);
  border-radius: .35rem;
  font: inherit;
  cursor: pointer;
}
button:not(:disabled):hover { border-color: var(--uc-accent); }
button:disabled { opacity: .5; cursor: default; }
</style>
