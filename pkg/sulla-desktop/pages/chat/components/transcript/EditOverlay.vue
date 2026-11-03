<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Inline edit overlay for a user message.

  Renders a textarea pre-populated with the current message text,
  along with Save / Cancel buttons.

  Keyboard:
    ⏎       → save
    ⇧⏎      → newline
    Esc     → cancel

  Parent is responsible for committing + regenerating; this component
  just emits what was typed.
-->
<template>
  <div class="edit-overlay" @click.self="$emit('cancel')">
    <div class="edit-panel">
      <textarea
        ref="taRef"
        v-model="draft"
        class="edit-textarea"
        rows="3"
        :placeholder="'Edit your message…'"
        @keydown="onKeydown"
      />
      <div class="edit-actions">
        <button type="button" class="btn ghost" @click="$emit('cancel')">Cancel</button>
        <button
          type="button"
          class="btn primary"
          :disabled="!canSave"
          @click="save"
        >
          Save
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, nextTick } from 'vue';

const props = defineProps<{
  /** Message id being edited (for parent bookkeeping). */
  messageId: string;
  /** Existing text to pre-populate. */
  initialText: string;
}>();

const emit = defineEmits<{
  (e: 'save', payload: { id: string; text: string }): void;
  (e: 'cancel'): void;
}>();

const draft = ref(props.initialText);
const taRef = ref<HTMLTextAreaElement | null>(null);

const canSave = computed(() =>
  draft.value.trim().length > 0 && draft.value !== props.initialText,
);

onMounted(async () => {
  await nextTick();
  if (taRef.value) {
    taRef.value.focus();
    // Place cursor at end of text.
    const len = taRef.value.value.length;
    taRef.value.setSelectionRange(len, len);
  }
});

function save(): void {
  if (!canSave.value) {
    emit('cancel');
    return;
  }
  emit('save', { id: props.messageId, text: draft.value.trim() });
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    emit('cancel');
    return;
  }
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    save();
  }
  // Shift+Enter → default newline behavior (let it through).
}
</script>

<style scoped>
.edit-overlay {
  position: absolute;
  inset: -6px -10px;
  z-index: 5;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  background: var(--accent-glow);
  border-radius: 10px;
  backdrop-filter: blur(6px);
  animation: edit-fade-in 0.12s ease-out;
}

.edit-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background: var(--accent);
  border: 1px solid var(--accent-glow);
  border-radius: 10px;
  box-shadow: 0 8px 32px var(--bg-page);
}

.edit-textarea {
  width: 100%;
  resize: vertical;
  min-height: 72px;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--accent);
  border: 1px solid var(--accent-dim);
  color: var(--text-primary, var(--accent));
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.edit-textarea:focus {
  border-color: var(--accent-glow);
  box-shadow: 0 0 0 2px var(--accent-dim);
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  padding: 6px 14px;
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s ease;
}
.btn.ghost {
  background: transparent;
  color: var(--text-secondary);
  border-color: var(--accent-dim);
}
.btn.ghost:hover {
  color: var(--text-primary);
  border-color: var(--accent-glow);
}
.btn.primary {
  background: var(--accent-dim);
  color: var(--text-secondary, var(--accent));
  border-color: var(--accent-glow);
}
.btn.primary:hover:not(:disabled) {
  background: var(--accent-glow);
  border-color: var(--accent);
}
.btn.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@keyframes edit-fade-in {
  from { opacity: 0; transform: scale(0.98); }
  to   { opacity: 1; transform: scale(1); }
}
</style>
