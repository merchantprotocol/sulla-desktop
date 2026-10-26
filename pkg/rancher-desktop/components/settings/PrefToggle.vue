<script setup lang="ts">
const props = defineProps<{
  modelValue: boolean;
  disabled?:  boolean;
  label?:     string;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>();

function flip() {
  if (!props.disabled) {
    emit('update:modelValue', !props.modelValue);
  }
}
</script>

<template>
  <button
    type="button"
    role="switch"
    class="tog"
    :class="{ on: modelValue }"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    @click="flip"
  />
</template>
