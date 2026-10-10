<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="inline-prompt-overlay"
      @mousedown.self="cancel"
    >
      <div
        class="inline-prompt-dialog"
        :class="{ dark: isDark }"
      >
        <div class="inline-prompt-title">
          {{ title }}
        </div>
        <input
          ref="inputRef"
          v-model="inputValue"
          class="inline-prompt-input"
          :class="{ dark: isDark }"
          :placeholder="placeholder"
          @keydown.enter="confirm"
          @keydown.escape="cancel"
        >
        <div class="inline-prompt-actions">
          <button
            class="inline-prompt-btn cancel"
            :class="{ dark: isDark }"
            @click="cancel"
          >
            Cancel
          </button>
          <button
            class="inline-prompt-btn confirm"
            :class="{ dark: isDark }"
            @click="confirm"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';

defineProps<{
  isDark: boolean;
}>();

const visible = ref(false);
const title = ref('');
const placeholder = ref('');
const inputValue = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

let resolvePromise: ((value: string | null) => void) | null = null;

async function show(promptTitle: string, defaultValue = '', promptPlaceholder = ''): Promise<string | null> {
  title.value = promptTitle;
  inputValue.value = defaultValue;
  placeholder.value = promptPlaceholder;
  visible.value = true;

  await nextTick();
  inputRef.value?.focus();
  inputRef.value?.select();

  return new Promise<string | null>((resolve) => {
    resolvePromise = resolve;
  });
}

function confirm() {
  visible.value = false;
  resolvePromise?.(inputValue.value);
  resolvePromise = null;
}

function cancel() {
  visible.value = false;
  resolvePromise?.(null);
  resolvePromise = null;
}

defineExpose({ show });
</script>

<style scoped>
.inline-prompt-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.inline-prompt-dialog {
  background: var(--bg-surface);
  border-radius: 8px;
  padding: 16px;
  width: 320px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.inline-prompt-title {
  font-size: var(--fs-code);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.inline-prompt-input {
  width: 100%;
  padding: 8px 10px;
  font-size: var(--fs-code);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-primary);
  outline: none;
  box-sizing: border-box;
}

.inline-prompt-input:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

.inline-prompt-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.inline-prompt-btn {
  padding: 6px 14px;
  font-size: var(--fs-code);
  font-weight: var(--weight-medium);
  border: none;
  border-radius: 5px;
  cursor: pointer;
}

.inline-prompt-btn.cancel {
  background: var(--bg-surface-alt);
  color: var(--text-secondary);
}

.inline-prompt-btn.cancel:hover {
  background: var(--bg-surface-hover);
}

.inline-prompt-btn.confirm {
  background: var(--accent-primary);
  color: var(--text-on-accent);
}

.inline-prompt-btn.confirm:hover {
  background: var(--accent-primary-hover);
}
</style>

<style scoped>
:global(.theme-noir-dark) .inline-prompt-overlay {
  background: rgba(1, 3, 10, 0.7);
  backdrop-filter: blur(8px);
}

:global(.theme-noir-dark) .inline-prompt-dialog {
  width: 360px;
  padding: 18px;
  gap: 14px;
  background: rgba(7, 13, 26, 0.96);
  border: 1px solid rgba(168, 192, 220, 0.12);
  border-radius: 18px;
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.64), inset 0 0 0 1px rgba(168, 192, 220, 0.025);
  animation: noir-prompt-in 0.42s cubic-bezier(.22, 1, .36, 1) both;
}

:global(.theme-noir-dark) .inline-prompt-title {
  color: #f3f5f8;
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 18px;
}

:global(.theme-noir-dark) .inline-prompt-input {
  height: 40px;
  color: #dee4ec;
  background: rgba(1, 3, 10, 0.72);
  border-color: rgba(168, 192, 220, 0.12);
  border-radius: 12px;
  font-family: ui-monospace, 'SF Mono', monospace;
}

:global(.theme-noir-dark) .inline-prompt-input:focus {
  border-color: rgba(106, 176, 204, 0.55);
  box-shadow: 0 0 0 3px rgba(80, 150, 179, 0.12);
}

:global(.theme-noir-dark) .inline-prompt-btn {
  min-width: 74px;
  height: 32px;
  padding: 0 14px;
  border-radius: 16px;
  transition: transform 0.42s cubic-bezier(.22, 1, .36, 1);
}

:global(.theme-noir-dark) .inline-prompt-btn.cancel {
  color: #a9b3c1;
  background: rgba(168, 192, 220, 0.06);
  border: 1px solid rgba(168, 192, 220, 0.1);
}

:global(.theme-noir-dark) .inline-prompt-btn.confirm {
  color: #fff;
  background: linear-gradient(180deg, #6ab0cc, #5096b3);
  box-shadow: 0 0 16px rgba(80, 150, 179, 0.35);
}

:global(.theme-noir-dark) .inline-prompt-btn:active { transform: scale(0.94); }

@keyframes noir-prompt-in {
  from { opacity: 0; transform: translateY(8px); filter: blur(8px); }
  to { opacity: 1; transform: none; filter: none; }
}

@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir-dark) .inline-prompt-dialog { animation: none; }
  :global(.theme-noir-dark) .inline-prompt-btn { transition-duration: 0.01ms; }
}
</style>
