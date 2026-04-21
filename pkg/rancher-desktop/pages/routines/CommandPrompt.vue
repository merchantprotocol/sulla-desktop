<template>
  <Transition name="cmdp">
    <div
      v-if="open"
      class="cmdp-root"
      @mousedown.self="close"
    >
      <div class="cmdp-backdrop" />

      <div
        class="cmdp-overlay"
        @mousedown.stop
      >
        <div class="cmdp-kicker">
          Ask Sulla · what do you want built?
        </div>

        <div class="cmdp-bar">
          <div class="cmdp-icn">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
            </svg>
          </div>

          <input
            ref="inputEl"
            v-model="text"
            type="text"
            placeholder="Describe the routine you want…"
            class="cmdp-input"
            spellcheck="false"
            autocomplete="off"
            @keydown.enter="onSubmit"
            @keydown.escape.prevent="close"
          >

          <div class="cmdp-kbd">
            <span>⌘</span><span>K</span>
          </div>
        </div>

        <div class="cmdp-hints">
          <span><kbd>↵</kbd>Build</span>
          <span><kbd>Esc</kbd>Dismiss</span>
          <span><kbd>⌘</kbd><kbd>/</kbd>Examples</span>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: 'close'):            void;
  (e: 'submit', q: string): void;
}>();

const text = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    text.value = '';
    await nextTick();
    inputEl.value?.focus();
  }
});

function close() {
  emit('close');
}
function onSubmit() {
  // Not wired to any backend yet — just emit so a parent can log / handle later.
  const q = text.value.trim();
  if (q) emit('submit', q);
  close();
}
</script>

<style scoped>
.cmdp-root {
  position: absolute;
  inset: 0;
  z-index: 60;
  color: #e6ecf5;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
}

.cmdp-backdrop {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse at 50% 34%,
      rgba(2, 5, 12, 0.72) 0%,
      rgba(2, 5, 12, 0.88) 55%,
      rgba(2, 5, 12, 0.94) 100%);
  backdrop-filter: blur(8px) saturate(110%);
  -webkit-backdrop-filter: blur(8px) saturate(110%);
}

.cmdp-overlay {
  position: absolute;
  left: 0; right: 0;
  top: 32%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 0 80px;
}

.cmdp-kicker {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10px;
  letter-spacing: 0.32em;
  color: #c4b5fd;
  text-transform: uppercase;
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.cmdp-kicker::before, .cmdp-kicker::after {
  content: '';
  width: 24px;
  height: 1px;
  background: #a78bfa;
  opacity: 0.6;
}

.cmdp-bar {
  width: 720px;
  max-width: 100%;
  display: grid;
  grid-template-columns: 32px 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 14px 14px 14px 18px;
  background: linear-gradient(180deg, rgba(22, 32, 54, 0.92), rgba(14, 22, 40, 0.96));
  border: 1px solid rgba(167, 139, 250, 0.35);
  border-radius: 12px;
  box-shadow:
    0 0 0 4px rgba(139, 92, 246, 0.08),
    0 24px 60px rgba(0, 0, 0, 0.55),
    0 4px 14px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(18px) saturate(130%);
  -webkit-backdrop-filter: blur(18px) saturate(130%);
}

.cmdp-icn {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: linear-gradient(135deg, #a78bfa, #7c3aed);
  display: grid;
  place-items: center;
  color: white;
  box-shadow:
    0 0 14px rgba(139, 92, 246, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.cmdp-input {
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  border: none;
  outline: none;
  padding: 0;
  margin: 0;
  color: white;
  font-family: inherit;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: -0.005em;
  caret-color: #c4b5fd;
  width: 100%;
  min-width: 0;
}
.cmdp-input::placeholder {
  color: #8cacc9;
  opacity: 0.9;
}

.cmdp-kbd {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
.cmdp-kbd span {
  padding: 4px 7px;
  border-radius: 4px;
  background: rgba(168, 192, 220, 0.1);
  border: 1px solid rgba(168, 192, 220, 0.2);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10px;
  color: #a8c0dc;
  letter-spacing: 0.05em;
}

.cmdp-hints {
  display: inline-flex;
  gap: 18px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10px;
  color: #6989b3;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.cmdp-hints kbd {
  display: inline-flex;
  align-items: center;
  padding: 3px 7px;
  border-radius: 3px;
  background: rgba(168, 192, 220, 0.08);
  border: 1px solid rgba(168, 192, 220, 0.18);
  color: #a8c0dc;
  font-family: inherit;
  font-size: 9px;
  margin-right: 6px;
  letter-spacing: 0.08em;
}

/* enter / leave transition — lift + fade */
.cmdp-enter-active, .cmdp-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.cmdp-enter-from {
  opacity: 0;
}
.cmdp-enter-from .cmdp-overlay {
  transform: translateY(6px);
}
.cmdp-leave-to {
  opacity: 0;
}
.cmdp-leave-to .cmdp-overlay {
  transform: translateY(6px);
}
</style>
