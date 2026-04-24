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
import { ref, watch, onMounted } from 'vue';

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

watch(() => props.modelValue, v => { if (v !== model.value) { model.value = v; autogrow(); } });
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
.input {
  flex: 1;
  font-family: var(--serif); font-style: italic;
  font-size: 18px; color: var(--read-1);
  background: transparent; border: none; outline: none;
  resize: none; min-height: 28px; max-height: 160px;
  padding: 0; width: 100%; line-height: 1.4;
  caret-color: var(--steel-400);
}
.input::placeholder { color: var(--read-4); font-style: italic; }
</style>
