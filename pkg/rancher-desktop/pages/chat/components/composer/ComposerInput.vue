<!-- Real textarea with auto-grow + emits send/keydown. -->
<template>
  <textarea
    ref="taRef"
    v-model="model"
    class="input"
    :placeholder="placeholder"
    rows="1"
    autocomplete="off"
    autocorrect="off"
    spellcheck="false"
    @input="autogrow"
    @keydown="onKeydown"
  />
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'send', v: string): void;
  (e: 'keydown', event: KeyboardEvent): void;
}>();

const taRef = ref<HTMLTextAreaElement | null>(null);
const model = ref(props.modelValue);

// Defer autogrow to the next frame so the textarea has actually been
// painted with the new value before we measure scrollHeight. Without
// this, clearing the draft (after send) measures the pre-clear height
// and leaves the textarea oversized.
watch(() => props.modelValue, v => {
  if (v !== model.value) {
    model.value = v;
    void nextTick(autogrow);
  }
});
watch(model, v => emit('update:modelValue', v));

onMounted(autogrow);

function autogrow(): void {
  const el = taRef.value; if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(160, el.scrollHeight) + 'px';
}

function onKeydown(e: KeyboardEvent): void {
  emit('keydown', e);
  if (e.defaultPrevented) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    emit('send', model.value);
  }
}

defineExpose({ el: taRef, focus: () => taRef.value?.focus() });
</script>

<style scoped>
/* !important beats the global `.theme-protocol-dark textarea` rule
   in assets/styles/themes/protocol-dark.css, which otherwise forces
   mono font + bright white on every textarea in the app. */
.input {
  flex: 1;
  font-family: var(--serif) !important; font-style: italic !important;
  font-size: 18px !important; color: var(--read-1) !important;
  background: transparent; border: none; outline: none;
  resize: none; min-height: 28px; max-height: 160px;
  padding: 0; width: 100%; line-height: 1.4;
  caret-color: var(--steel-400);
}
.input::placeholder {
  color: var(--read-4) !important;
  font-family: var(--serif) !important;
  font-style: italic !important;
  font-size: 18px !important;
}
</style>
