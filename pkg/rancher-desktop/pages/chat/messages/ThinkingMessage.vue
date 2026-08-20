<template>
  <div
    class="thinking-inline"
    :class="{
      completed: completed && !expanded,
      expanded: completed && expanded,
    }"
    @click="toggle"
  >
    <div
      v-if="!completed"
      class="ti-helix-col"
    >
      <div class="helix-container">
        <div class="helix-dot t1" /><div class="helix-dot t2" /><div class="helix-dot t3" /><div class="helix-dot t4" /><div class="helix-dot t5" />
        <div class="helix-dot b1" /><div class="helix-dot b2" /><div class="helix-dot b3" /><div class="helix-dot b4" /><div class="helix-dot b5" />
        <div class="helix-rung" /><div class="helix-rung" /><div class="helix-rung" /><div class="helix-rung" /><div class="helix-rung" />
      </div>
      <div class="ti-stem" />
      <div class="ti-elapsed">
        {{ elapsed }}
      </div>
    </div>
    <div class="ti-content">
      <div class="ti-label">
        {{ completed ? `Synthesized in ${elapsed}` : 'Synthesizing' }}
      </div>
      <div class="ti-stream">
        <div
          :ref="el => scrollToBottom(el)"
          class="ti-stream-inner"
        >
          <div
            v-for="(line, idx) in thinkingLines"
            :key="idx"
            class="ti-thought"
          >
            <span class="ti-thought-num">{{ String(idx + 1).padStart(2, '0') }}</span>
            <span v-html="renderMarkdown(line)" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';

import { renderMarkdown } from './markdown';

import type { ChatMessage } from '@pkg/pages/agent/ChatInterface';

const props = defineProps<{ message: ChatMessage }>();

const expanded = ref(false);
const completed = computed(() => !!(props.message as any)._completed);

const thinkingLines = computed(() => {
  const content = props.message.content || '';

  return content
    .split(/\n+/)
    .map(l => l.trim())
    .filter(l => l.length > 0);
});

// Live elapsed counter — starts when the message first renders, freezes
// at whatever it reads when the backend marks the message completed.
const startMs = Date.now();
const elapsed = ref('0.0s');
let timer: ReturnType<typeof setInterval> | null = null;

function startTimer() {
  if (timer) return;
  timer = setInterval(() => {
    elapsed.value = `${ ((Date.now() - startMs) / 1000).toFixed(1) }s`;
  }, 100);
}

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

watch(completed, (done) => {
  if (done) {
    stopTimer();
  } else {
    startTimer();
  }
}, { immediate: true });
onUnmounted(stopTimer);

function toggle() {
  if (completed.value) expanded.value = !expanded.value;
}

function scrollToBottom(el: any) {
  if (el instanceof HTMLElement) {
    nextTick(() => { el.scrollTop = el.scrollHeight });
  }
}
</script>

<style scoped>
/* ── DNA Helix ── */
.helix-container {
  width: 40px;
  height: 28px;
  position: relative;
  flex-shrink: 0;
}

.helix-dot {
  position: absolute;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent-primary, #5096b3);
}

.helix-dot.t1 { animation: helixTop 1.6s ease-in-out infinite 0s; left: 2px; }
.helix-dot.t2 { animation: helixTop 1.6s ease-in-out infinite 0.2s; left: 10px; }
.helix-dot.t3 { animation: helixTop 1.6s ease-in-out infinite 0.4s; left: 18px; }
.helix-dot.t4 { animation: helixTop 1.6s ease-in-out infinite 0.6s; left: 26px; }
.helix-dot.t5 { animation: helixTop 1.6s ease-in-out infinite 0.8s; left: 34px; }

.helix-dot.b1 { animation: helixBot 1.6s ease-in-out infinite 0s; left: 2px; }
.helix-dot.b2 { animation: helixBot 1.6s ease-in-out infinite 0.2s; left: 10px; }
.helix-dot.b3 { animation: helixBot 1.6s ease-in-out infinite 0.4s; left: 18px; }
.helix-dot.b4 { animation: helixBot 1.6s ease-in-out infinite 0.6s; left: 26px; }
.helix-dot.b5 { animation: helixBot 1.6s ease-in-out infinite 0.8s; left: 34px; }

@keyframes helixTop {
  0%, 100% { top: 2px;  opacity: 1;   transform: scale(1); }
  50%      { top: 20px; opacity: 0.3; transform: scale(0.6); }
}

@keyframes helixBot {
  0%, 100% { top: 20px; opacity: 0.3; transform: scale(0.6); }
  50%      { top: 2px;  opacity: 1;   transform: scale(1); }
}

.helix-rung {
  position: absolute;
  width: 1px;
  background: rgba(80, 150, 179, 0.15);
  top: 6px;
  height: 16px;
  animation: rungPulse 1.6s ease-in-out infinite;
}
.helix-rung:nth-child(11) { left: 4px;  animation-delay: 0s; }
.helix-rung:nth-child(12) { left: 12px; animation-delay: 0.2s; }
.helix-rung:nth-child(13) { left: 20px; animation-delay: 0.4s; }
.helix-rung:nth-child(14) { left: 28px; animation-delay: 0.6s; }
.helix-rung:nth-child(15) { left: 36px; animation-delay: 0.8s; }

@keyframes rungPulse {
  0%, 100% { opacity: 0.15; }
  25%, 75% { opacity: 0.4; }
  50%      { opacity: 0.15; }
}

/* ── Compact Inline Thinking ── */
.thinking-inline {
  display: flex;
  gap: 14px;
  padding: 0;
  align-items: flex-start;
  cursor: pointer;
}

.ti-helix-col {
  padding-top: 2px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.ti-stem {
  width: 1px;
  flex: 1;
  min-height: 20px;
  background: rgba(80, 150, 179, 0.1);
  animation: stemPulse 2s ease-in-out infinite;
}

@keyframes stemPulse {
  0%, 100% { opacity: 0.3; }
  50%      { opacity: 0.8; }
}

.ti-elapsed {
  font-size: 9px;
  color: rgba(80, 150, 179, 0.35);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ti-content {
  flex: 1;
  min-width: 0;
}

.ti-label {
  font-size: 12px;
  color: var(--accent-primary, #5096b3);
  font-weight: 500;
  margin-bottom: 8px;
}

/* Scrolling thought stream */
.ti-stream {
  position: relative;
  max-height: 110px;
  overflow: hidden;
}

.ti-stream::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 20px;
  background: linear-gradient(to bottom, var(--bg-page, #0d1117), transparent);
  pointer-events: none;
  z-index: 2;
}

.ti-stream::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 24px;
  background: linear-gradient(to top, var(--bg-page, #0d1117), transparent);
  pointer-events: none;
  z-index: 2;
}

.ti-stream-inner {
  max-height: inherit;
  overflow-y: auto;
  scrollbar-width: none;
}

.ti-stream-inner::-webkit-scrollbar {
  display: none;
}

.ti-thought {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 10px;
  margin-bottom: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted, rgba(230, 237, 243, 0.35));
  font-style: italic;
  border-left: 2px solid rgba(80, 150, 179, 0.12);
  border-radius: 0 4px 4px 0;
  background: rgba(80, 150, 179, 0.03);
}

.ti-thought-num {
  color: rgba(80, 150, 179, 0.3);
  font-size: 10px;
  font-style: normal;
  font-weight: 600;
  flex-shrink: 0;
}

.ti-thought :deep(p) {
  margin: 0;
  display: inline;
}

/* ── Completed (collapsed) ── */
.thinking-inline.completed {
  align-items: center;
  transition: opacity 0.3s;
}

.thinking-inline.completed .ti-stream { display: none; }
.thinking-inline.completed .ti-stem { display: none; }
.thinking-inline.completed .ti-elapsed { display: none; }
.thinking-inline.completed .ti-label {
  color: rgba(80, 150, 179, 0.4);
  margin-bottom: 0;
}
.thinking-inline.completed:hover .ti-label { color: rgba(80, 150, 179, 0.55); }

/* ── Expanded (completed + clicked open) ── */
.thinking-inline.expanded {
  align-items: flex-start;
}

.thinking-inline.expanded .ti-stream {
  max-height: none;
}
.thinking-inline.expanded .ti-stream::before,
.thinking-inline.expanded .ti-stream::after { display: none; }
.thinking-inline.expanded .ti-thought { color: var(--text-muted, rgba(230, 237, 243, 0.45)); }
.thinking-inline.expanded .ti-stem { animation: none; opacity: 0.2; }
.thinking-inline.expanded .ti-label { color: rgba(80, 150, 179, 0.4); }
</style>
