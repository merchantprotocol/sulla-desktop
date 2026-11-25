<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Presentational status roll-up; the chat presenter owns the scoped source data. -->
<template>
  <div
    ref="rootElement"
    v-if="displayItem || (pinned && historyItems.length)"
    class="status-rollup"
    :class="{ 'is-pinned': pinned, 'is-reduced-motion': reducedMotion, 'is-document-hidden': !documentVisible }"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <Transition name="rollup-flight" mode="out-in">
      <button
        v-if="displayItem"
        :key="`${ displayItem.key }:${ displayItem.agentId }:${ displayItem.text }`"
        type="button"
        class="status-rollup__line"
        :data-urgency="displayItem.urgency"
        :aria-label="`${ displayItem.agentName }${ displayItem.lane ? ` · ${ displayItem.lane }` : '' }: ${ displayItem.text }`"
        aria-haspopup="true"
        :aria-expanded="pinned"
        @click="togglePinned"
      >
        <span
          class="status-rollup__marker"
          :data-role="displayItem.role"
          :data-urgency="displayItem.urgency"
          aria-hidden="true"
        >{{ displayItem.agentName.slice(0, 1).toLocaleUpperCase() }}</span>
        <span class="status-rollup__who">{{ displayItem.agentName }}</span>
        <span v-if="displayItem.lane" class="status-rollup__lane">{{ displayItem.lane }}</span>
        <span class="status-rollup__separator" aria-hidden="true">·</span>
        <span class="status-rollup__text">{{ displayItem.text }}</span>
        <span
          v-if="displayItem.urgency === 'needs-you' || displayItem.urgency === 'failed'"
          class="status-rollup__urgency"
          :data-urgency="displayItem.urgency"
          aria-hidden="true"
        >{{ displayItem.urgency === 'failed' ? '×' : '!' }}</span>
        <span class="status-rollup__pin" aria-hidden="true">{{ pinned ? '⌄' : '⌃' }}</span>
      </button>
    </Transition>

    <Transition name="rollup-history">
      <section
        v-if="pinned && historyItems.length"
        class="status-rollup__history"
        aria-label="Recent check-ins"
      >
        <ol>
          <li v-for="item in historyItems" :key="item.key">
            <span
              class="status-rollup__marker status-rollup__marker--history"
              :data-role="item.role"
              :data-urgency="item.urgency"
              aria-hidden="true"
            >{{ item.agentName.slice(0, 1).toLocaleUpperCase() }}</span>
            <span class="status-rollup__history-who">{{ item.agentName }}</span>
            <span v-if="item.lane" class="status-rollup__history-lane">{{ item.lane }}</span>
            <span class="status-rollup__history-text">{{ item.text }}</span>
            <time :datetime="new Date(item.observedAt).toISOString()">
              {{ new Date(item.observedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }}
            </time>
          </li>
        </ol>
      </section>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { StatusRollupQueue, type StatusRollupItem, type StatusRollupShownEvent } from './StatusRollupQueue';

const props = defineProps<{
  /** Active chat-thread identifier; records for any other thread are ignored. */
  threadId: string;
  /** Check-ins already scoped by the presenter to this root and its descendants. */
  checkIns: readonly StatusRollupItem[];
  /** Current root-agent status shown when no queued check-in is visible. */
  rootFallback?: StatusRollupItem | null;
}>();

const emit = defineEmits<{ shown: [payload: StatusRollupShownEvent] }>();

const queue = new StatusRollupQueue();
const rootElement = ref<HTMLElement | null>(null);
const currentItem = ref<StatusRollupItem | null>(null);
const historyItems = ref<readonly StatusRollupItem[]>([]);
const hovered = ref(false);
const pinned = ref(false);
const documentVisible = ref(true);
const reducedMotion = ref(false);
const mounted = ref(false);
let activeThreadId = '';
let timer: number | undefined;
let motionQuery: MediaQueryList | undefined;

const isPaused = computed(() => hovered.value || pinned.value || !documentVisible.value);
const fallbackItem = computed(() => props.rootFallback
  ? queue.present({ ...props.rootFallback, role: 'root' }, props.threadId, Date.now())
  : null);
const displayItem = computed(() => currentItem.value ?? fallbackItem.value);

const refresh = (): void => {
  const now = Date.now();
  const shown = queue.pump(now, isPaused.value);
  if (shown) emit('shown', { key: shown.key, agentId: shown.agentId, threadId: shown.threadId });
  currentItem.value = queue.current ?? fallbackItem.value;
  historyItems.value = queue.history;
};

const syncInput = (): void => {
  const now = Date.now();
  if (activeThreadId !== props.threadId) {
    activeThreadId = props.threadId;
    queue.reset(activeThreadId);
    currentItem.value = null;
    historyItems.value = [];
    pinned.value = false;
    hovered.value = false;
  }

  const visible = currentItem.value ?? queue.current ?? fallbackItem.value;
  queue.observe(props.checkIns, props.threadId, now, visible);
  queue.seed(props.checkIns, props.threadId, now);
  currentItem.value = queue.current ?? fallbackItem.value;
  historyItems.value = queue.history;
  if (mounted.value) refresh();
};

const togglePinned = (): void => {
  pinned.value = !pinned.value;
  refresh();
};

const syncVisibility = (): void => {
  documentVisible.value = !document.hidden;
  const root = rootElement.value;
  const animations = root && typeof root.getAnimations === 'function' ? root.getAnimations({ subtree: true }) : [];
  for (const animation of animations) {
    if (documentVisible.value) animation.play();
    else animation.pause();
  }
  refresh();
};

const syncReducedMotion = (event?: MediaQueryListEvent): void => {
  reducedMotion.value = event?.matches ?? motionQuery?.matches ?? false;
};

watch(
  () => [props.threadId, props.checkIns, props.rootFallback] as const,
  syncInput,
  { deep: true, immediate: true },
);

onMounted(() => {
  mounted.value = true;
  documentVisible.value = !document.hidden;
  document.addEventListener('visibilitychange', syncVisibility);
  if (typeof window.matchMedia === 'function') {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    syncReducedMotion();
    motionQuery.addEventListener('change', syncReducedMotion);
  }
  refresh();
  timer = window.setInterval(refresh, 100);
});

onBeforeUnmount(() => {
  mounted.value = false;
  hovered.value = false;
  if (timer !== undefined) window.clearInterval(timer);
  document.removeEventListener('visibilitychange', syncVisibility);
  motionQuery?.removeEventListener('change', syncReducedMotion);
});
</script>

<style scoped>
.status-rollup {
  position: relative;
  min-width: 0;
  color: var(--text-primary);
  font-family: var(--font-body, inherit);
}

.status-rollup__line {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: min(470px, 100%);
  padding: 5px 10px 5px 6px;
  border: 0;
  border-radius: 999px;
  background: var(--surface-1);
  color: var(--text-primary);
  box-shadow: 0 1px 3px color-mix(in srgb, var(--text-primary) 10%, transparent);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.status-rollup__line:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}

.status-rollup__marker {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 22px;
  aspect-ratio: 1;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent-primary) 16%, var(--surface-1));
  color: var(--primary-color-text-override, var(--accent-primary));
  font-size: 11px;
  font-weight: 650;
  line-height: 1;
}

.status-rollup__marker[data-role='root'] {
  background: var(--accent-primary);
  color: var(--text-on-accent);
}

.status-rollup__marker[data-role='manager'] {
  background: color-mix(in srgb, var(--accent-primary) 20%, var(--surface-1));
  color: var(--primary-color-text-override, var(--accent-primary));
}

.status-rollup__marker[data-role='reviewer'] {
  background: var(--surface-2);
  color: var(--text-secondary);
}

.status-rollup__marker[data-urgency='needs-you'] {
  background: var(--status-warning);
  color: var(--text-on-accent);
}

.status-rollup__marker[data-urgency='failed'] {
  background: var(--status-error);
  color: var(--text-on-accent);
}

.status-rollup__who,
.status-rollup__lane,
.status-rollup__separator,
.status-rollup__urgency,
.status-rollup__pin {
  flex: none;
  white-space: nowrap;
}

.status-rollup__who {
  max-width: 110px;
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
}

.status-rollup__lane,
.status-rollup__separator,
.status-rollup__pin {
  color: var(--text-muted);
  font-size: 11px;
}

.status-rollup__lane {
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-rollup__text {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-rollup__line[data-urgency='needs-you'] .status-rollup__text,
.status-rollup__line[data-urgency='needs-you'] .status-rollup__who {
  color: var(--status-warning);
}

.status-rollup__line[data-urgency='failed'] .status-rollup__text,
.status-rollup__line[data-urgency='failed'] .status-rollup__who {
  color: var(--status-error);
}

.status-rollup__urgency {
  margin-left: auto;
  font-size: 12px;
  font-weight: 700;
}

.status-rollup__urgency[data-urgency='needs-you'] { color: var(--status-warning); }
.status-rollup__urgency[data-urgency='failed'] { color: var(--status-error); }
.status-rollup__pin { margin-left: 1px; }

.status-rollup__history {
  position: absolute;
  z-index: 10;
  bottom: calc(100% + 8px);
  left: 0;
  width: min(430px, 100%);
  max-height: min(280px, 60vh);
  overflow: auto;
  padding: 6px;
  border-radius: 16px;
  background: var(--surface-1);
  color: var(--text-primary);
  box-shadow: 0 12px 34px color-mix(in srgb, var(--text-primary) 18%, transparent);
}

.status-rollup__history ol {
  display: grid;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.status-rollup__history li {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 5px 7px;
  border-radius: 9px;
}

.status-rollup__history li:hover { background: var(--surface-2); }
.status-rollup__marker--history { width: 19px; font-size: 10px; }
.status-rollup__history-who {
  flex: none;
  max-width: 88px;
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-rollup__history-lane {
  flex: none;
  max-width: 76px;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-rollup__history-text { flex: 1; min-width: 0; overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.status-rollup__history time { flex: none; padding-left: 4px; color: var(--text-muted); font-size: 10px; font-variant-numeric: tabular-nums; }

.rollup-flight-enter-active,
.rollup-flight-leave-active {
  transition: opacity 180ms ease, transform 240ms cubic-bezier(.22, 1, .36, 1);
}

.rollup-flight-enter-from {
  opacity: 0;
  transform: translateY(5px);
}

.rollup-flight-leave-to {
  opacity: 0;
  transform: translateY(-7px);
}

.rollup-history-enter-active,
.rollup-history-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.rollup-history-enter-from,
.rollup-history-leave-to {
  opacity: 0;
  transform: translateY(5px);
}

.is-document-hidden .rollup-flight-enter-active,
.is-document-hidden .rollup-flight-leave-active,
.is-document-hidden .rollup-history-enter-active,
.is-document-hidden .rollup-history-leave-active {
  transition: none;
}

.is-reduced-motion .rollup-flight-enter-active,
.is-reduced-motion .rollup-flight-leave-active,
.is-reduced-motion .rollup-history-enter-active,
.is-reduced-motion .rollup-history-leave-active {
  transition: opacity 160ms ease;
}

.is-reduced-motion .rollup-flight-enter-from,
.is-reduced-motion .rollup-flight-leave-to,
.is-reduced-motion .rollup-history-enter-from,
.is-reduced-motion .rollup-history-leave-to {
  transform: none;
}

@media (prefers-reduced-motion: reduce) {
  .rollup-flight-enter-active,
  .rollup-flight-leave-active,
  .rollup-history-enter-active,
  .rollup-history-leave-active { transition: opacity 160ms ease; }
  .rollup-flight-enter-from,
  .rollup-flight-leave-to,
  .rollup-history-enter-from,
  .rollup-history-leave-to { transform: none; }
}
</style>
