<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
/** One ledger line's effort control: Default plus each level the model offers. */
import { defaultEffort, effortLabel, effortLevels, isLevelBlocked } from './laneLogic';
import { LedgerText } from './ledgerText';
import { providerName } from './routingLogic';

import type { ClassModel, ModelRoutingState } from '@pkg/agent/languagemodels/modelRoutingTypes';

defineProps<{ state: ModelRoutingState; view: ModelRoutingState; m: ClassModel; role: string; edited: boolean }>();
const emit = defineEmits<(e: 'set', effort: string | undefined) => void>();
</script>

<template>
  <span
    class="ld-seg"
    :class="{ ed: edited }"
    role="radiogroup"
    :aria-label="`${providerName(state, m.provider)} effort for ${role}`"
  >
    <template v-if="effortLevels(state, m).length">
      <button
        type="button"
        role="radio"
        :aria-checked="!m.effort"
        :title="defaultEffort(state, m) ? `${providerName(state, m.provider)} reports ${effortLabel(defaultEffort(state, m)!)} as the default` : `${providerName(state, m.provider)} reports no default`"
        @click="emit('set', undefined)"
      >Default<span
        v-if="defaultEffort(state, m)"
        class="ld-dft ld-full"
      > ({{ effortLabel(defaultEffort(state, m)!) }})</span></button>
      <button
        v-for="l in effortLevels(state, m)"
        :key="l.id"
        type="button"
        role="radio"
        :aria-checked="m.effort === l.id"
        :disabled="isLevelBlocked(view, m.provider, m.model, l.id) && m.effort !== l.id"
        :class="{ badsel: m.effort === l.id && isLevelBlocked(view, m.provider, m.model, l.id) }"
        :title="isLevelBlocked(view, m.provider, m.model, l.id) ? 'On your never-use list for this model' : l.description"
        @click="emit('set', l.id)"
      ><span class="ld-full">{{ effortLabel(l.id) }}</span><span class="ld-short">{{ LedgerText.effortShort(l.id) }}</span></button>
    </template>
    <span
      v-else
      class="ld-dim"
    >No effort setting</span>
  </span>
</template>

<style scoped src="./RoleLedger.css"></style>
