<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- A live-only status line; the chat presenter owns scoped source data and subscription freshness. -->
<template>
  <div
    v-if="displayItem || ghosts.length || (pinned && historyItems.length)"
    class="status-rollup"
    :class="{ 'is-pinned': pinned, 'is-reduced-motion': reducedMotion }"
  >
    <div v-if="ghosts.length" class="status-rollup__ghost-layer" aria-hidden="true">
      <div
        v-for="ghost in ghosts"
        :key="ghost.id"
        class="status-rollup__ghost"
        :style="{ '--rollup-dx': `${ ghost.dx }px`, '--rollup-dy': `${ ghost.dy }px`, '--rollup-duration': `${ ghost.durationMs }ms` }"
        @animationend="removeGhost(ghost.id)"
      >
        <span class="status-rollup__dot" :data-role="ghost.item.role" />
        <span class="status-rollup__who">{{ ghost.item.agentName }}</span>
        <span class="status-rollup__kind">{{ ghost.item.kind || 'agent' }}</span>
        <span class="status-rollup__separator">·</span>
        <span class="status-rollup__text">{{ ghost.item.text }}</span>
      </div>
    </div>

    <button
      v-if="displayItem"
      type="button"
      class="status-rollup__line"
      :data-urgency="displayItem.urgency"
      :aria-label="`${ displayItem.agentName } · ${ displayItem.kind || 'agent' }: ${ displayItem.text }`"
      aria-haspopup="true"
      :aria-expanded="pinned"
      @click="togglePinned"
    >
      <span
        class="status-rollup__dot"
        :class="{ 'is-popping': dotPopping }"
        :data-role="displayItem.role"
        :data-urgency="displayItem.urgency"
        aria-hidden="true"
      />
      <span class="status-rollup__who">{{ displayItem.agentName }}</span>
      <span class="status-rollup__kind">{{ displayItem.kind || 'agent' }}</span>
      <span class="status-rollup__separator" aria-hidden="true">·</span>
      <span class="status-rollup__text" aria-live="polite">{{ displayItem.text }}</span>
      <span
        v-if="displayItem.urgency === 'needs-you' || displayItem.urgency === 'failed'"
        class="status-rollup__urgency"
        :data-urgency="displayItem.urgency"
        aria-hidden="true"
      >{{ displayItem.urgency === 'failed' ? '×' : '!' }}</span>
      <span class="status-rollup__pin" aria-hidden="true">{{ pinned ? '⌄' : '⌃' }}</span>
    </button>

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

interface StatusRollupGhost {
  readonly id: number;
  readonly item: StatusRollupItem;
  readonly dx: number;
  readonly dy: number;
  readonly durationMs: number;
}

const props = defineProps<{
  /** Active chat-thread identifier; records for any other thread are ignored. */
  threadId: string;
  /** Check-ins already scoped by the presenter to this root and its descendants. */
  checkIns: readonly StatusRollupItem[];
  /** Retained for composer compatibility; idle fallback state is intentionally not rendered. */
  rootFallback?: StatusRollupItem | null;
}>();

const emit = defineEmits<{
  shown: [payload: StatusRollupShownEvent];
  consumed: [];
  'consumer-attached': [];
  'consumer-detached': [];
}>();

const queue = new StatusRollupQueue();
const currentItem = ref<StatusRollupItem | null>(null);
const ghosts = ref<StatusRollupGhost[]>([]);
const historyItems = ref<readonly StatusRollupItem[]>([]);
const pinned = ref(false);
const reducedMotion = ref(false);
const mounted = ref(false);
const dotPopping = ref(false);
let activeThreadId = '';
let subscribedAt: number | null = null;
let dwellTimer: number | undefined;
let dotTimer: number | undefined;
let nextGhostId = 0;
const ghostTimers = new Map<number, number>();
let motionQuery: MediaQueryList | undefined;

const displayItem = computed(() => currentItem.value);

const emitShown = (item: StatusRollupItem): void => {
  emit('shown', {
    key: item.key,
    agentId: item.agentId,
    threadId: item.threadId,
    role: item.role,
    kind: item.kind,
    phase: item.phase,
    correlationId: item.correlationId,
  });
};

const clearDwellTimer = (): void => {
  if (dwellTimer !== undefined) window.clearTimeout(dwellTimer);
  dwellTimer = undefined;
};

const removeGhost = (id: number): void => {
  const timer = ghostTimers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  ghostTimers.delete(id);
  ghosts.value = ghosts.value.filter(ghost => ghost.id !== id);
};

const createGhost = (item: StatusRollupItem): void => {
  const id = ++nextGhostId;
  const ghost: StatusRollupGhost = reducedMotion.value
    ? { id, item, dx: 0, dy: 0, durationMs: 260 }
    : {
      id,
      item,
      dx: (Math.random() * 2 - 1) * 18,
      dy: 22 + Math.random() * 30,
      durationMs: Math.round(1_500 + Math.random() * 1_100),
    };
  ghosts.value = [...ghosts.value, ghost];
  ghostTimers.set(id, window.setTimeout(() => removeGhost(id), ghost.durationMs));
};

const clearGhosts = (): void => {
  for (const timer of ghostTimers.values()) window.clearTimeout(timer);
  ghostTimers.clear();
  ghosts.value = [];
};

const showItem = (item: StatusRollupItem): void => {
  const previous = currentItem.value;
  if (previous?.key === item.key) {
    if (previous.text !== item.text) currentItem.value = item;
    return;
  }
  if (previous) createGhost(previous);
  clearDwellTimer();
  currentItem.value = item;
  queue.markShown(item);
  if (dotTimer !== undefined) window.clearTimeout(dotTimer);
  dotPopping.value = !reducedMotion.value;
  dotTimer = window.setTimeout(() => { dotPopping.value = false; dotTimer = undefined; }, 160);
  emitShown(item);
  const shownKey = item.key;
  dwellTimer = window.setTimeout(() => {
    dwellTimer = undefined;
    const shown = currentItem.value;
    if (!shown || shown.key !== shownKey) return;
    currentItem.value = null;
    queue.clearCurrent(shown.key);
    createGhost(shown);
  }, 2_000);
};

const syncInput = (): void => {
  const now = Date.now();
  const threadChanged = activeThreadId !== props.threadId;
  if (threadChanged) {
    activeThreadId = props.threadId;
    queue.reset(activeThreadId);
    clearDwellTimer();
    currentItem.value = null;
    dotPopping.value = false;
    clearGhosts();
    historyItems.value = [];
    pinned.value = false;
    subscribedAt = mounted.value ? now : null;
  }

  if (!mounted.value) {
    queue.prime(props.checkIns, props.threadId);
    return;
  }

  const item = queue.observe(props.checkIns, props.threadId, now, subscribedAt ?? now);
  if (props.checkIns.length) emit('consumed');
  if (item) showItem(item);
  historyItems.value = queue.history;
};

const togglePinned = (): void => {
  pinned.value = !pinned.value;
};

const syncReducedMotion = (event?: MediaQueryListEvent): void => {
  reducedMotion.value = event?.matches ?? motionQuery?.matches ?? false;
  if (reducedMotion.value) {
    dotPopping.value = false;
    ghosts.value = ghosts.value.map(ghost => {
      const timer = ghostTimers.get(ghost.id);
      if (timer !== undefined) window.clearTimeout(timer);
      const reducedGhost = { ...ghost, dx: 0, dy: 0, durationMs: 260 };
      ghostTimers.set(ghost.id, window.setTimeout(() => removeGhost(ghost.id), reducedGhost.durationMs));
      return reducedGhost;
    });
  }
};

watch(
  () => [props.threadId, props.checkIns] as const,
  syncInput,
  { deep: true, immediate: true },
);

onMounted(() => {
  mounted.value = true;
  subscribedAt = Date.now();
  emit('consumer-attached');
  if (typeof window.matchMedia === 'function') {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    syncReducedMotion();
    motionQuery.addEventListener('change', syncReducedMotion);
  }
});

onBeforeUnmount(() => {
  emit('consumer-detached');
  mounted.value = false;
  clearDwellTimer();
  if (dotTimer !== undefined) window.clearTimeout(dotTimer);
  clearGhosts();
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

.status-rollup__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-primary);
  transition: transform 160ms ease;
}

.status-rollup__dot[data-role='reviewer'] { background: var(--text-secondary); }
.status-rollup__dot[data-urgency='needs-you'] { background: var(--status-warning); }
.status-rollup__dot[data-urgency='failed'] { background: var(--status-error); }
.status-rollup__dot.is-popping { transform: scale(1.5); }

.status-rollup__who,
.status-rollup__kind,
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

.status-rollup__kind,
.status-rollup__separator,
.status-rollup__pin {
  color: var(--text-muted);
  font-size: 11px;
}

.status-rollup__kind {
  max-width: 56px;
  overflow: hidden;
  text-transform: lowercase;
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

.status-rollup__ghost-layer {
  position: absolute;
  z-index: 1;
  top: 0;
  bottom: 0;
  left: 0;
  width: min(470px, 100%);
  pointer-events: none;
}

.status-rollup__ghost {
  position: absolute;
  top: 3px;
  left: 6px;
  display: flex;
  align-items: center;
  gap: 7px;
  width: calc(100% - 12px);
  height: 22px;
  min-width: 0;
  overflow: hidden;
  line-height: 22px;
  font-size: 12px;
  white-space: nowrap;
  animation: status-rollup-ghost var(--rollup-duration) cubic-bezier(.3, .2, .2, 1) forwards;
}

.status-rollup__ghost .status-rollup__who { max-width: 105px; }

@keyframes status-rollup-ghost {
  0% { opacity: .7; transform: translate(0, 0) scale(1); }
  16% { opacity: .5; transform: translate(calc(var(--rollup-dx) * .12), -27px) scale(.99); }
  100% { opacity: 0; transform: translate(var(--rollup-dx), calc(-27px - var(--rollup-dy))) scale(.96); }
}

@keyframes status-rollup-ghost-reduced {
  from { opacity: .55; transform: none; }
  to { opacity: 0; transform: none; }
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

.rollup-history-enter-active,
.rollup-history-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.rollup-history-enter-from,
.rollup-history-leave-to {
  opacity: 0;
  transform: translateY(5px);
}

.is-reduced-motion .status-rollup__ghost {
  animation-name: status-rollup-ghost-reduced;
}

.is-reduced-motion .rollup-history-enter-active,
.is-reduced-motion .rollup-history-leave-active {
  transition: opacity 160ms ease;
}

.is-reduced-motion .rollup-history-enter-from,
.is-reduced-motion .rollup-history-leave-to {
  transform: none;
}

@media (prefers-reduced-motion: reduce) {
  .status-rollup__ghost {
    animation-name: status-rollup-ghost-reduced;
    animation-duration: 260ms !important;
  }
  .rollup-history-enter-active,
  .rollup-history-leave-active { transition: opacity 160ms ease; }
  .rollup-history-enter-from,
  .rollup-history-leave-to { transform: none; }
}
</style>
