<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { rangePercent } from '@pkg/utils/preferencesModel';

const props = defineProps<{
  modelValue: number;
  min:        number;
  max:        number;
  step?:      number;
  ticks?:     string[];
  /** Formats the value shown at the end of the track. */
  format?:    (value: number) => string;
  disabled?:  boolean;
  label?:     string;
}>();
// Only `change` (on release) is emitted, so dragging doesn't restart Docker on every step.
const emit = defineEmits<{ (e: 'change', value: number): void }>();

const draft = ref(props.modelValue);

watch(() => props.modelValue, (value) => {
  draft.value = value;
});

const pct = computed(() => rangePercent(draft.value, props.min, props.max));
const shown = computed(() => props.format ? props.format(draft.value) : String(draft.value));

function onInput(event: Event) {
  draft.value = Number((event.target as HTMLInputElement).value);
}

function onChange() {
  if (draft.value !== props.modelValue) {
    emit('change', draft.value);
  }
}
</script>

<template>
  <div :class="{ 'range-off': disabled }">
    <div class="range">
      <div class="trk">
        <i :style="{ width: `${ pct }%` }" />
        <b :style="{ left: `${ pct }%` }" />
        <input
          type="range"
          :min="min"
          :max="max"
          :step="step ?? 1"
          :value="draft"
          :disabled="disabled"
          :aria-label="label"
          @input="onInput"
          @change="onChange"
        >
      </div>
      <span class="val">{{ shown }}</span>
    </div>
    <div
      v-if="ticks?.length"
      class="ticks"
    >
      <span
        v-for="(tick, index) in ticks"
        :key="index"
      >{{ tick }}</span>
    </div>
  </div>
</template>
