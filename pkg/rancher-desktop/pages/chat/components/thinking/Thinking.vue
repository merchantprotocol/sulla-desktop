<!--
  Thinking block — unified component covering three states:
    • live     — pulsing dot, scrolling recent thoughts, elapsed timer
    • settled  — collapsed single-line summary (click to expand)
    • expanded — numbered list of every thought

  The message kind itself doesn't change; we use `msg.completed` and a
  local `open` ref to switch display modes.
-->
<template>
  <div
    :class="['thinking', liveClass, openClass]"
    :data-thinking="true"
    @click="toggleOpen"
  >
    <div class="head">
      <template v-if="msg.completed">
        <span v-if="!open" class="summary">{{ msg.summary || 'Thought for a moment' }}</span>
        <span v-else class="label">{{ msg.thoughts.length }} thoughts</span>
        <span class="elapsed">{{ msg.thoughts.length }} thoughts · {{ elapsedLabel }}</span>
        <span class="chev">▸</span>
      </template>
      <template v-else>
        <span>Sulla is thinking</span>
        <span class="elapsed">{{ elapsedLabel }} · {{ msg.thoughts.length }} thoughts</span>
      </template>
    </div>

    <!-- Live stream: show last 3 thoughts with fade -->
    <div v-if="!msg.completed" class="stream">
      <div
        v-for="(t, idx) in visibleLive"
        :key="idx"
        class="thought"
      >
        {{ t }}
      </div>
    </div>

    <!-- Expanded: numbered list -->
    <div class="expanded">
      <ol>
        <li v-for="(t, idx) in msg.thoughts" :key="idx">{{ t }}</li>
      </ol>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import type { ThinkingMessage } from '../../models/Message';

const props = defineProps<{ msg: ThinkingMessage }>();

const open = ref(false);
const liveClass = computed(() => props.msg.completed ? 'settled' : 'live');
const openClass = computed(() => open.value ? 'open' : '');

function toggleOpen(): void {
  if (!props.msg.completed) return;  // live blocks aren't expandable
  open.value = !open.value;
}

const visibleLive = computed(() => props.msg.thoughts.slice(-3));

// Live elapsed counter
const tick = ref(0);
let interval: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  if (!props.msg.completed) {
    interval = setInterval(() => { tick.value++; }, 100);
  }
});
onBeforeUnmount(() => { if (interval) clearInterval(interval); });

const elapsedLabel = computed(() => {
  const end = props.msg.completed ? (props.msg.thoughts.length > 0 ? props.msg.startedAt + props.msg.thoughts.length * 500 : Date.now()) : Date.now();
  void tick.value;
  const secs = (end - props.msg.startedAt) / 1000;
  return `${ secs.toFixed(1) }s`;
});
</script>

<style scoped>
.thinking {
  position: relative; padding: 12px 0 12px 22px;
  border-left: 1px solid rgba(80, 150, 179, 0.22);
  cursor: pointer; transition: border-color 0.25s ease;
}
.thinking:hover { border-left-color: rgba(106, 176, 204, 0.5); }
.thinking::before {
  content: ""; position: absolute; left: -4px; top: 18px;
  width: 7px; height: 7px; border-radius: 50%;
  background: rgba(80, 150, 179, 0.45); transition: all 0.25s ease;
}
.thinking.live { border-left-color: rgba(106, 176, 204, 0.55); }
.thinking.live::before {
  background: var(--steel-400); box-shadow: 0 0 14px var(--steel-400);
  animation: chat-pulse 1.5s infinite;
}
.head {
  font-family: var(--mono); font-size: 10px;
  letter-spacing: 0.25em; text-transform: uppercase;
  color: var(--steel-400);
  margin-bottom: 10px;
  display: flex; align-items: center; gap: 14px;
}
.head .summary {
  font-family: var(--serif); font-style: italic;
  text-transform: none; letter-spacing: 0.003em;
  font-size: 15px; color: var(--read-3);
  font-weight: 400;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 1;
}
.thinking.settled:hover .head .summary { color: var(--read-2); }
.head .elapsed {
  font-variant-numeric: tabular-nums;
  color: var(--read-4); font-size: 10px; margin-left: auto;
}
.head .chev { color: var(--read-4); transition: transform 0.25s ease; }
.thinking.open .head .chev { transform: rotate(90deg); }

.stream {
  max-height: 80px; overflow: hidden;
  -webkit-mask-image: linear-gradient(180deg, rgba(0,0,0,0.3) 0%, black 40%);
          mask-image: linear-gradient(180deg, rgba(0,0,0,0.3) 0%, black 40%);
}
.thought {
  font-family: var(--serif); font-style: italic;
  font-size: 15px; line-height: 1.55; color: var(--read-3);
  padding: 2px 0;
}
.thought:nth-child(1) { opacity: 0.4; }
.thought:nth-child(2) { opacity: 0.7; }
.thought:nth-child(3) { opacity: 1; color: var(--read-2); }

.expanded {
  max-height: 0; overflow: hidden; transition: max-height 0.4s ease;
}
.thinking.open .expanded { max-height: 600px; padding-top: 6px; }
.expanded ol { list-style: none; counter-reset: t; padding: 0; margin: 0; }
.expanded li {
  counter-increment: t;
  font-family: var(--serif); font-style: italic;
  font-size: 15px; line-height: 1.6; color: var(--read-3);
  padding: 4px 0 4px 30px; position: relative;
}
.expanded li::before {
  content: counter(t, decimal-leading-zero);
  position: absolute; left: 0; top: 6px;
  font-family: var(--mono); font-style: normal;
  font-size: 9.5px; color: var(--read-5);
}
</style>
