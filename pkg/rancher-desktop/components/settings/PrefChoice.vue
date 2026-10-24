<script setup lang="ts">
export interface PrefChoiceOption {
  value:     string;
  title:     string;
  subtitle?: string;
  tag?:      string;
  disabled?: boolean;
}

const props = defineProps<{
  modelValue: string;
  options:    PrefChoiceOption[];
  disabled?:  boolean;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();

function pick(option: PrefChoiceOption) {
  if (!props.disabled && !option.disabled && option.value !== props.modelValue) {
    emit('update:modelValue', option.value);
  }
}
</script>

<template>
  <div
    class="choice"
    role="radiogroup"
  >
    <div
      v-for="option in options"
      :key="option.value"
      class="opt"
      role="radio"
      :tabindex="option.disabled || disabled ? -1 : 0"
      :aria-checked="option.value === modelValue"
      :aria-disabled="option.disabled || disabled"
      :class="{ on: option.value === modelValue, dis: option.disabled || disabled }"
      @click="pick(option)"
      @keydown.enter.prevent="pick(option)"
      @keydown.space.prevent="pick(option)"
    >
      <span class="rd" />
      <span class="t"><b>{{ option.title }}</b><small v-if="option.subtitle">{{ option.subtitle }}</small></span>
      <span
        v-if="option.tag"
        class="rec"
      >{{ option.tag }}</span>
    </div>
  </div>
</template>
