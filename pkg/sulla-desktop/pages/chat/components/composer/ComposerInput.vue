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
    aria-label="Message Sulla"
    :placeholder="placeholder"
    :aria-activedescendant="activeDescendant"
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
  el.style.overflowY = 'hidden';
  el.style.height = 'auto';
  // scrollHeight includes padding, but a border-box height also needs the border.
  const borderHeight = el.offsetHeight - el.clientHeight;
  el.style.height = Math.min(160, el.scrollHeight + borderHeight) + 'px';
  el.style.overflowY = el.scrollHeight > el.clientHeight ? 'auto' : 'hidden';
}

function onKeydown(e: KeyboardEvent): void {
  emit('keydown', e);
  if (e.defaultPrevented) return;
  if (e.isComposing || e.keyCode === 229) return;
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
  flex: 1 1 0;
  width: auto; min-width: 0; min-height: 24px; max-height: 160px;
  margin: 0 !important; padding: 0 10px !important;
  border: 0 !important; border-radius: 0 !important; outline: 0 !important;
  color: var(--text-primary) !important; background: transparent !important; box-shadow: none !important;
  font-family: var(--font-body) !important; font-size: 16px !important;
  font-style: normal !important; line-height: 24px; letter-spacing: -0.005em;
  caret-color: var(--text-primary);
}
.input::placeholder {
  color: var(--text-dim) !important; opacity: 1;
  font-family: var(--font-body) !important; font-size: 16px !important; font-style: normal !important;
}
</style>
