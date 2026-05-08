<template>
  <Teleport to="body">
    <div v-if="visible" class="inline-prompt-overlay" @mousedown.self="cancel">
      <div class="inline-prompt-dialog">
        <div class="inline-prompt-title">{{ title }}</div>
        <input
          ref="inputRef"
          v-model="inputValue"
          class="inline-prompt-input"
          :placeholder="placeholder"
          @keydown.enter="confirm"
          @keydown.escape="cancel"
        >
        <div class="inline-prompt-actions">
          <button class="inline-prompt-btn cancel" @click="cancel">Cancel</button>
          <button class="inline-prompt-btn confirm" @click="confirm">OK</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';

const visible     = ref(false);
const title       = ref('');
const placeholder = ref('');
const inputValue  = ref('');
const inputRef    = ref<HTMLInputElement | null>(null);

let resolvePromise: ((value: string | null) => void) | null = null;

async function show(promptTitle: string, defaultValue = '', promptPlaceholder = ''): Promise<string | null> {
  title.value       = promptTitle;
  inputValue.value  = defaultValue;
  placeholder.value = promptPlaceholder;
  visible.value     = true;
  await nextTick();
  inputRef.value?.focus();
  inputRef.value?.select();
  return new Promise<string | null>((resolve) => { resolvePromise = resolve; });
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
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 10000;
}
.inline-prompt-dialog {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px; padding: 16px; width: 320px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  display: flex; flex-direction: column; gap: 12px;
}
.inline-prompt-title { font-size: var(--fs-code); font-weight: 600; color: var(--text); }
.inline-prompt-input {
  width: 100%; padding: 8px 10px;
  font-size: var(--fs-code);
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text); outline: none; box-sizing: border-box;
}
.inline-prompt-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim); }
.inline-prompt-actions { display: flex; justify-content: flex-end; gap: 8px; }
.inline-prompt-btn {
  padding: 6px 14px; font-size: var(--fs-code);
  border: none; border-radius: 5px; cursor: pointer;
}
.inline-prompt-btn.cancel { background: var(--surface-3); color: var(--text-muted); }
.inline-prompt-btn.cancel:hover { background: var(--border); }
.inline-prompt-btn.confirm { background: var(--accent); color: #fff; }
.inline-prompt-btn.confirm:hover { background: var(--accent-hover); }
</style>
