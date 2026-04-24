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
  background: rgba(10, 16, 24, 0.55);
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
  background: rgba(20, 30, 42, 0.88);
  border: 1px solid rgba(80, 150, 179, 0.35);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55);
}

.edit-textarea {
  width: 100%;
  resize: vertical;
  min-height: 72px;
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(10, 16, 24, 0.75);
  border: 1px solid rgba(168, 192, 220, 0.18);
  color: var(--read-1, #d9e3ef);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.edit-textarea:focus {
  border-color: rgba(80, 150, 179, 0.65);
  box-shadow: 0 0 0 2px rgba(80, 150, 179, 0.18);
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  padding: 6px 14px;
  border-radius: 6px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s ease;
}
.btn.ghost {
  background: transparent;
  color: var(--read-3);
  border-color: rgba(168, 192, 220, 0.2);
}
.btn.ghost:hover {
  color: var(--read-1);
  border-color: rgba(168, 192, 220, 0.4);
}
.btn.primary {
  background: rgba(80, 150, 179, 0.22);
  color: var(--steel-100, #cfe6f0);
  border-color: rgba(80, 150, 179, 0.55);
}
.btn.primary:hover:not(:disabled) {
  background: rgba(80, 150, 179, 0.38);
  border-color: rgba(106, 176, 204, 0.8);
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
