<template>
  <Teleport to="body">
    <div v-if="visible" class="inline-prompt-overlay" @mousedown.self="cancel">
      <div class="inline-prompt-dialog" :class="{ dark: isDark }">
        <div class="inline-prompt-title">{{ title }}</div>
        <input
          ref="inputRef"
          v-model="inputValue"
          class="inline-prompt-input"
          :class="{ dark: isDark }"
          :placeholder="placeholder"
          @keydown.enter="confirm"
          @keydown.escape="cancel"
        />
        <div class="inline-prompt-actions">
          <button class="inline-prompt-btn cancel" :class="{ dark: isDark }" @click="cancel">Cancel</button>
          <button class="inline-prompt-btn confirm" :class="{ dark: isDark }" @click="confirm">OK</button>
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
