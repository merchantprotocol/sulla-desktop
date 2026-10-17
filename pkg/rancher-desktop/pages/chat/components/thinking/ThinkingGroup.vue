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
  border-left: 1px solid rgba(80, 150, 179, 0.22);
}
.thinking::before {
  content: ""; position: absolute; left: -4px; top: 18px;
  width: 7px; height: 7px; border-radius: 50%;
  background: rgba(80, 150, 179, 0.45);
}
.thinking.live { border-left-color: rgba(106, 176, 204, 0.55); }
.thinking.live::before {
  background: var(--steel-400); box-shadow: 0 0 14px var(--steel-400);
  animation: chat-pulse 1.5s infinite;
}
.head {
  width: 100%; padding: 0; border: 0; background: transparent;
  display: flex; align-items: center; gap: 14px; text-align: left;
  font: 10px var(--mono); letter-spacing: 0.25em; text-transform: uppercase;
  color: var(--steel-400); cursor: pointer;
}
.live .head { cursor: default; }
.summary {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--read-3); font: italic 15px var(--serif); letter-spacing: 0.003em; text-transform: none;
}
.elapsed { margin-left: auto; color: var(--read-4); letter-spacing: 0.1em; }
.chev { color: var(--read-4); transition: transform 0.2s ease; }
.open .chev { transform: rotate(90deg); }
.noir-summary { display: none; }
.stream { margin-top: 10px; }
.thought {
  padding: 3px 0; color: var(--read-3);
  font: italic 15px/1.55 var(--serif);
}
.expanded {
  margin-top: 10px; max-height: min(65vh, 900px) !important; overflow-y: auto !important; padding-right: 8px;
}
.expanded-thought { position: relative; padding-left: 30px; }
.index {
  position: absolute; left: 0; top: 5px;
  color: var(--read-5); font: 9.5px var(--mono); font-style: normal;
}
:deep(.tool) { flex-wrap: wrap; border-left: 0; padding-left: 0; }
:deep(.tool::before) { left: 1px; }
</style>
