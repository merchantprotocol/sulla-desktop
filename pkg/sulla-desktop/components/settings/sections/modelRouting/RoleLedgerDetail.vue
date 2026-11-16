<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
/** A ledger line opened with More: how the model is chosen, order, never-use and removal. */
import { effortLabel } from './laneLogic';
import { LedgerText } from './ledgerText';
import { CLASS_LABELS } from './routingLogic';

import type { ClassModel, ModelClass, ModelRoutingState, ModelRule, NeverUsePair } from '@pkg/agent/languagemodels/modelRoutingTypes';

const props = defineProps<{
  state:    ModelRoutingState;
  m:        ClassModel;
  role:     ModelClass;
  /** The line's position in the role's lane, and among the role's visible lines. */
  index:    number;
  shown:    number;
  count:    number;
  ruleText: string | undefined;
  preview:  (rule: ModelRule) => string;
}>();
const emit = defineEmits<{
  (e: 'pick', model: string): void;
  (e: 'rule', rule: ModelRule): void;
  (e: 'update:ruleText', text: string): void;
  (e: 'move', delta: number): void;
  (e: 'never', pair: NeverUsePair): void;
  (e: 'remove'): void;
}>();
const label = (p: string, model: string) => LedgerText.label(props.state, p, model);
function onContainsInput(event: Event) {
  const text = (event.target as HTMLInputElement).value;
  emit('update:ruleText', text);
  if (text.trim()) emit('rule', { kind: 'contains', text: text.trim() });
}
</script>

<template>
  <div class="ld-det">
    <div>
      <h4>How the model is chosen</h4>
      <div
        class="ld-rules"
        role="radiogroup"
      >
        <label><input
          type="radio"
          :name="`rule-${role}-${index}`"
          :checked="!m.rule"
          @change="emit('pick', m.model)"
        > The model I pick <span class="ld-dim">{{ label(m.provider, m.model) }}</span></label>
        <label v-if="state.providers.find(x => x.id === m.provider)?.models.length"><input
          type="radio"
          :name="`rule-${role}-${index}`"
          :checked="m.rule?.kind === 'first'"
          @change="emit('rule', { kind: 'first' })"
        > First model in the provider's list <span class="ld-dim">{{ preview({ kind: 'first' }) }}</span></label>
        <label v-if="state.providers.find(x => x.id === m.provider)?.models.length"><input
                                                                                      type="radio"
                                                                                      :name="`rule-${role}-${index}`"
                                                                                      :checked="m.rule?.kind === 'contains'"
                                                                                      @change="(ruleText ?? '').trim() && emit('rule', { kind: 'contains', text: ruleText!.trim() })"
                                                                                    > Name contains
          <input
            class="inp sm ld-rule-in"
            maxlength="60"
            placeholder="text"
            aria-label="Text the model name must contain"
            :value="ruleText ?? (m.rule?.kind === 'contains' ? m.rule.text : '')"
            @input="onContainsInput"
          >
          <span class="ld-dim">{{ (ruleText ?? '').trim() ? preview({ kind: 'contains', text: ruleText!.trim() }) : '' }}</span>
        </label>
      </div>
    </div>
    <div class="ld-acts">
      <button
        type="button"
        class="btn sm"
        :disabled="shown === 0"
        @click="emit('move', -1)"
      >
        Try earlier
      </button>
      <button
        type="button"
        class="btn sm"
        :disabled="shown === count - 1"
        @click="emit('move', 1)"
      >
        Try later
      </button>
      <button
        type="button"
        class="btn sm"
        @click="emit('never', { provider: m.provider, model: m.model, effort: m.effort || 'any' })"
      >
        Never use {{ label(m.provider, m.model) }} at {{ m.effort ? effortLabel(m.effort) : 'any effort' }}
      </button>
      <button
        type="button"
        class="ld-ghost ld-rm"
        @click="emit('remove')"
      >
        Remove from {{ CLASS_LABELS[role] }}
      </button>
    </div>
  </div>
</template>

<style scoped src="./RoleLedger.css"></style>
