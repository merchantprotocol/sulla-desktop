<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- One chronological, collapsible work log for thoughts and tool activity. -->
<template>
  <section
    :class="['thinking', completed ? 'settled' : 'live', { open }]"
    :data-thinking="true"
  >
    <button
      class="head"
      type="button"
      :aria-expanded="open"
      @click="toggleOpen"
    >
      <template v-if="completed">
        <span class="noir-summary">{{ completionLabel }}</span>
        <span
          v-if="!open"
          class="summary"
        >{{ summary }}</span>
        <span
          v-if="open"
          class="label"
        >{{ items.length }} entries</span>
        <span class="elapsed">{{ completedMeta }}</span>
        <span class="chev">▸</span>
      </template>
      <template v-else>
        <span>Sulla is thinking</span>
        <span class="elapsed">{{ elapsedLabel }} · {{ items.length }} entries</span>
        <span class="chev">▸</span>
      </template>
    </button>

    <div
      v-if="!completed || open"
      :class="open ? 'expanded' : 'stream'"
    >
      <template
        v-for="(item, index) in visibleItems"
        :key="item.key"
      >
        <div
          v-if="item.kind === 'thought'"
          :class="['thought', { 'expanded-thought': open }]"
        >
          <span
            v-if="open"
            class="index"
          >{{ String(index + 1).padStart(2, '0') }}</span>
          {{ item.text }}
        </div>
        <ToolCall
          v-else
          :msg="item.message"
        />
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import ToolCall from '../tool/ToolCall.vue';

import type { ThinkingMessage, ToolMessage } from '../../models/Message';

const props = defineProps<{ messages: readonly (ThinkingMessage | ToolMessage)[] }>();
const open = ref(false);

type WorkItem =
  | { kind: 'thought'; key: string; text: string }
  | { kind: 'tool'; key: string; message: ToolMessage };

const items = computed<WorkItem[]>(() => props.messages.flatMap<WorkItem>(message => {
  if (message.kind === 'tool') {
    return [{ kind: 'tool' as const, key: message.id, message }];
  }
  return message.thoughts.map((text, index) => ({
    kind: 'thought' as const,
    key:  `${ message.id }:${ index }`,
    text,
  }));
}));
const completed = computed(() => props.messages.every(message =>
  message.kind === 'thinking' ? message.completed : message.status !== 'running'));
const hasThinking = computed(() => props.messages.some(message => message.kind === 'thinking'));
const startedAt = computed(() => Math.min(...props.messages.map(message =>
  message.kind === 'thinking' ? message.startedAt : message.createdAt)));
const completedAt = computed(() => Math.max(startedAt.value, ...props.messages.map(message =>
  message.kind === 'thinking' ? (message.completedAt ?? message.createdAt) : message.createdAt)));
const summary = computed(() => {
  const first = items.value[0];
  if (!first) return 'Thought for a moment';
  return first.kind === 'thought' ? first.text : first.message.desc || first.message.tool;
});
const visibleLive = computed(() => items.value.slice(-4));
const visibleItems = computed(() => open.value ? items.value : visibleLive.value);
const completionLabel = computed(() => hasThinking.value ? `Thought for ${ elapsedLabel.value }` : 'Work details');
const completedMeta = computed(() => hasThinking.value
  ? `${ items.value.length } entries · ${ elapsedLabel.value }`
  : `${ items.value.length } entries`);

function toggleOpen(): void {
  open.value = !open.value;
}

const tick = ref(0);
let interval: ReturnType<typeof setInterval> | null = null;
function startTicking(): void {
  if (!interval) interval = setInterval(() => { tick.value++ }, 100);
}
function stopTicking(): void {
  if (interval) clearInterval(interval);
  interval = null;
}
onMounted(() => { if (!completed.value) startTicking(); });
watch(completed, done => done ? stopTicking() : startTicking());
onBeforeUnmount(stopTicking);

const elapsedLabel = computed(() => {
  const end = completed.value ? completedAt.value : Date.now() + tick.value * 0;
  return `${ Math.max(0, (end - startedAt.value) / 1000).toFixed(1) }s`;
});
</script>

<style scoped>
.thinking {
  position: relative; padding: 12px 0 12px 22px;
  border-left: 1px solid var(--accent-dim);
}
.thinking::before {
  content: ""; position: absolute; left: -4px; top: 18px;
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent-glow);
}
.thinking.live { border-left-color: var(--accent-glow); }
.thinking.live::before {
  background: var(--accent-hover); box-shadow: 0 0 14px var(--accent-hover);
  animation: chat-pulse 1.5s infinite;
}
.head {
  width: 100%; padding: 0; border: 0; background: transparent;
  display: flex; align-items: center; gap: 14px; text-align: left;
  font: 10px var(--font-mono); letter-spacing: 0.25em; text-transform: uppercase;
  color: var(--accent-hover); cursor: pointer;
}
.live .head { cursor: default; }
.summary {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-secondary); font: italic 15px var(--font-display); letter-spacing: 0.003em; text-transform: none;
}
.elapsed { margin-left: auto; color: var(--text-muted); letter-spacing: 0.1em; }
.chev { color: var(--text-muted); transition: transform 0.2s ease; }
.open .chev { transform: rotate(90deg); }
.noir-summary { display: none; }
.stream { margin-top: 10px; }
.thought {
  padding: 3px 0; color: var(--text-secondary);
  font: italic 15px/1.55 var(--font-display);
}
.expanded {
  margin-top: 10px; max-height: min(65vh, 900px) !important; overflow-y: auto !important; padding-right: 8px;
}
.expanded-thought { position: relative; padding-left: 30px; }
.index {
  position: absolute; left: 0; top: 5px;
  color: var(--text-dim); font: 9.5px var(--font-mono); font-style: normal;
}
:deep(.tool) { flex-wrap: wrap; border-left: 0; padding-left: 0; }
:deep(.tool::before) { left: 1px; }
</style>
