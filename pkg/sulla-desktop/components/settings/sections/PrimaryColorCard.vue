<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->

<script setup lang="ts">
import { computed } from 'vue';

import PrefCard from '../PrefCard.vue';
import PrefRow from '../PrefRow.vue';

import { usePrimaryColor } from '@pkg/composables/usePrimaryColor';
import { PRIMARY_COLOR_PRESETS } from '@pkg/config/primaryColor';

const { primaryColor, setPrimaryColor, resetPrimaryColor } = usePrimaryColor();
const presets = PRIMARY_COLOR_PRESETS;
const customValue = computed(() => primaryColor.value ?? presets[0].value);
const customSelected = computed(() => Boolean(primaryColor.value) && !presets.some(preset => preset.value === primaryColor.value));

function chooseCustom(event: Event): void {
  setPrimaryColor((event.target as HTMLInputElement).value);
}
</script>

<template>
  <PrefCard
    title="Primary color"
    subtitle="Change the app accent, links and focus color without changing your theme."
  >
    <template #actions>
      <button
        type="button"
        class="btn sm ghost"
        :disabled="primaryColor === null"
        @click="resetPrimaryColor"
      >
        Reset to theme default
      </button>
    </template>

    <PrefRow
      title="Color"
      subtitle="The custom color stays in place when you switch themes or light and dark mode."
    >
      <div
        class="primary-color-options"
        role="group"
        aria-label="Primary color presets"
      >
        <button
          v-for="preset in presets"
          :key="preset.value"
          type="button"
          class="primary-color-swatch-button"
          :class="{ selected: primaryColor === preset.value }"
          :style="{ '--primary-color-swatch': preset.value }"
          :aria-pressed="primaryColor === preset.value"
          :aria-label="preset.label"
          :title="preset.label"
          @click="setPrimaryColor(preset.value)"
        >
          <span class="primary-color-swatch" aria-hidden="true" />
        </button>
        <label class="primary-color-custom" :class="{ selected: customSelected }">
          <span class="primary-color-custom-preview" :style="{ '--primary-color-swatch': customValue }" aria-hidden="true" />
          <span>Custom</span>
          <input
            type="color"
            :value="customValue"
            aria-label="Choose custom primary color"
            @input="chooseCustom"
          >
        </label>
      </div>
    </PrefRow>
  </PrefCard>
</template>

<style scoped>
.primary-color-options {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.primary-color-swatch-button {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: var(--bg-surface);
  cursor: pointer;
}

.primary-color-swatch-button:hover,
.primary-color-swatch-button:focus-visible,
.primary-color-swatch-button.selected {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}

.primary-color-swatch {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--primary-color-swatch);
}

.primary-color-custom {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  padding: 4px 10px 4px 5px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  color: var(--text-secondary);
  cursor: pointer;
}

.primary-color-custom:hover,
.primary-color-custom:focus-within,
.primary-color-custom.selected {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px var(--accent-dim);
}

.primary-color-custom-preview {
  width: 24px;
  height: 24px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: var(--primary-color-swatch);
}

.primary-color-custom input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}
</style>
