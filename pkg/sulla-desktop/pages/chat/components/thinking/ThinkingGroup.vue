<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  One chronological work log for thoughts and tool activity, collapsed to a
  single line that says what it is doing (live) or did (finished). Expanded,
  it lists readable steps with each raw command one click away, and the full
  log exactly as recorded.
-->
<template>
  <WorkBlock
    :icon="completed ? '✓' : ''"
    tone="think"
    :live="!completed"
    :by="by"
  >
    <template #title>
      <b>{{ title.lead }}</b><template v-if="title.rest">
        · {{ title.rest }}
      </template>
    </template>
    <template #meta>
      {{ elapsedLabel }} · {{ steps.length }} step{{ steps.length === 1 ? '' : 's' }}
    </template>

    <ul
      v-if="!showLog"
      class="tg-steps"
    >
      <li
        v-for="step in steps"
        :key="step.key"
        class="tg-step"
      >
        <template v-if="step.kind === 'run' && step.tool">
          <ToolCall :msg="step.tool" />
        </template>
        <template v-else>
          <span class="tg-k">{{ step.kind === 'run' ? 'run' : step.kind === 'think' ? 'think' : 'note' }}</span>
          <span
            class="tg-v"
            :class="{ 'tg-thought': step.kind === 'think' }"
          >
            <template v-if="step.kind === 'run'"><b>{{ step.title }}</b><template v-if="step.detail"> · <code>{{ step.detail }}</code></template></template>
            <template v-else>{{ step.text }}</template>
          </span>
          <button
            v-if="step.kind === 'run' && step.raw"
            type="button"
            class="tg-link"
            :aria-expanded="rawOpen.has(step.key)"
            @click="toggleRaw(step.key)"
          >
            raw
          </button>
          <pre
            v-if="step.kind === 'run' && rawOpen.has(step.key)"
            class="tg-raw"
          >{{ step.raw }}</pre>
        </template>
      </li>
    </ul>
    <ol
      v-else
      class="tg-log"
    >
      <li
        v-for="entry in log"
        :key="entry.key"
      >
        {{ entry.text }}
      </li>
    </ol>
    <button
      type="button"
      class="tg-link tg-switch"
      @click="showLog = !showLog"
    >
      {{ showLog ? 'Show readable steps' : `Show all ${log.length} entries as logged` }}
    </button>
  </WorkBlock>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import { workSteps, workTitle } from '../../messages/workSteps';
import ToolCall from '../tool/ToolCall.vue';
import WorkBlock from '../transcript/WorkBlock.vue';

import type { ThinkingMessage, ToolMessage } from '../../models/Message';

const props = defineProps<{ messages: readonly (ThinkingMessage | ToolMessage)[] }>();

const steps = computed(() => workSteps(props.messages));
const completed = computed(() => props.messages.every(message =>
  message.kind === 'thinking' ? message.completed : message.status !== 'running'));
const summary = computed(() => props.messages.find((message): message is ThinkingMessage => message.kind === 'thinking' && !!message.summary)?.summary);
const title = computed(() => workTitle(steps.value, completed.value, summary.value));
const by = computed(() => props.messages.find(message => message.by)?.by);

/** Every entry exactly as recorded, fillers included. */
const log = computed(() => props.messages.flatMap(message => (message.kind === 'tool'
  ? [{ key: message.id, text: `${ message.tool } · ${ message.desc }${ message.meta ? ` · ${ message.meta }` : '' }` }]
  : message.thoughts.map((text, index) => ({ key: `${ message.id }:${ index }`, text })))));

const showLog = ref(false);
const rawOpen = reactive(new Set<string>());
function toggleRaw(key: string): void { if (rawOpen.has(key)) rawOpen.delete(key); else rawOpen.add(key); }

const startedAt = computed(() => Math.min(...props.messages.map(message =>
  message.kind === 'thinking' ? message.startedAt : message.createdAt)));
const completedAt = computed(() => Math.max(startedAt.value, ...props.messages.map(message =>
  message.kind === 'thinking' ? (message.completedAt ?? message.createdAt) : message.createdAt)));

const tick = ref(0);
let interval: ReturnType<typeof setInterval> | null = null;
function startTicking(): void { if (!interval) interval = setInterval(() => { tick.value++ }, 1000); }
function stopTicking(): void { if (interval) clearInterval(interval); interval = null }
onMounted(() => { if (!completed.value) startTicking(); });
watch(completed, done => (done ? stopTicking() : startTicking()));
onBeforeUnmount(stopTicking);

const elapsedLabel = computed(() => {
  const end = completed.value ? completedAt.value : Date.now() + tick.value * 0;
  const seconds = Math.max(0, Math.round((end - startedAt.value) / 1000));
  return seconds < 60 ? `${ seconds }s` : `${ Math.floor(seconds / 60) }m ${ seconds % 60 }s`;
});
</script>

<style scoped>
.tg-steps, .tg-log { margin: 8px 0 0; padding: 0; list-style: none; max-height: min(60vh, 760px); overflow-y: auto; }
.tg-step {
  display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 10px; align-items: baseline;
  padding: 5px 0; border-bottom: 1px solid var(--border-default); font-size: 13px;
}
.tg-step:last-child { border-bottom: 0; }
.tg-step :deep(.tool) { grid-column: 1 / -1; }
.tg-k { color: var(--wb-ink-3); font: 11px var(--font-mono, ui-monospace, monospace); letter-spacing: .04em; text-transform: uppercase; }
.tg-v { min-width: 0; overflow-wrap: anywhere; color: var(--wb-ink-2); }
.tg-v b { color: var(--text-primary); font-weight: 600; }
.tg-v code { color: var(--text-primary); font: 12px var(--font-mono, ui-monospace, monospace); }
.tg-thought { font-style: italic; }
.tg-link { padding: 0; border: 0; background: none; color: var(--wb-ink-3); font: inherit; font-size: 12px; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.tg-link:hover { color: var(--text-primary); }
.tg-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
.tg-raw {
  grid-column: 2 / -1; margin: 2px 0 4px; padding: 8px 10px; border-radius: 7px; background: var(--wb-raised);
  color: var(--wb-ink-2); font: 12px/1.55 var(--font-mono, ui-monospace, monospace); white-space: pre-wrap; overflow-wrap: anywhere;
}
.tg-log { padding-left: 0; counter-reset: entry; }
.tg-log li { counter-increment: entry; padding: 3px 0 3px 34px; position: relative; color: var(--wb-ink-2); font: 12px/1.55 var(--font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
.tg-log li::before { content: counter(entry, decimal-leading-zero); position: absolute; left: 0; color: var(--wb-ink-3); }
.tg-switch { display: inline-block; margin-top: 8px; }
</style>
