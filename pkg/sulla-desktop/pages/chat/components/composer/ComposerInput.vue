<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Real textarea with auto-grow + emits send/keydown. -->
<template>
  <textarea
    ref="taRef"
    v-model="model"
    class="input"
    :placeholder="placeholder"
    :aria-activedescendant="activeDescendant"
    rows="1"
    autocomplete="off"
    autocorrect="off"
    spellcheck="false"
    @keydown="onKeydown"
  />
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

import { useFocusGuard } from '@pkg/composables/useFocusGuard';

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
  activeDescendant?: string;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'send', v: string): void;
  (e: 'keydown', event: KeyboardEvent): void;
}>();

const taRef = ref<HTMLTextAreaElement | null>(null);
useFocusGuard(taRef);
const model = ref(props.modelValue);

watch(() => props.modelValue, value => { model.value = value });
watch(model, value => emit('update:modelValue', value));

function onKeydown(e: KeyboardEvent): void {
  emit('keydown', e);
  if (e.defaultPrevented) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('sulla:send-hop-keydown', { detail: performance.now() }));
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
  box-sizing: border-box;
  font-family: var(--font-display) !important; font-style: italic !important;
  font-size: 18px !important; color: var(--text-primary) !important;
  background: transparent; border: none; outline: none;
  resize: none; min-height: 28px; max-height: 160px;
  padding: 0; width: 100%; line-height: 1.4;
  caret-color: var(--text-primary);
}
.input::placeholder {
  color: var(--text-muted) !important;
  font-family: var(--font-display) !important;
  font-style: italic !important;
  font-size: 18px !important;
}
.input {
  flex: 0 0 100%; align-self: flex-start;
  field-sizing: content; overflow-y: auto;
  width: 100%; min-height: 54px; max-height: 160px;
  margin: 0 !important; padding: 15px 18px 10px !important;
  border: 0 !important; border-radius: 0 !important; outline: 0 !important;
  color: var(--text-primary) !important; background: transparent !important; box-shadow: none !important;
  font-family: var(--font-body) !important; font-size: 15.5px !important;
  font-style: normal !important; line-height: 1.45; letter-spacing: -0.005em;
  caret-color: var(--text-primary);
}
/* A long placeholder can wrap when the composer is narrow. */
.input:placeholder-shown { height: 54px; overflow-y: hidden; }
.input::placeholder {
  color: var(--text-dim) !important; opacity: 1;
  font-family: var(--font-body) !important; font-size: 15.5px !important; font-style: normal !important;
}
</style>
