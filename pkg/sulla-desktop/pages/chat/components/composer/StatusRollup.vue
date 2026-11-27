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
    v-if="displayItem || trailItems.length || (pinned && historyItems.length)"
    class="status-rollup"
    :class="{ 'is-pinned': pinned, 'is-reduced-motion': reducedMotion, 'is-document-hidden': !documentVisible }"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <TransitionGroup v-if="trailItems.length" name="rollup-trail" tag="div" class="status-rollup__trail" aria-hidden="true">
      <div
        v-for="(item, index) in trailItems"
        :key="item.key"
        class="status-rollup__trail-item"
        :class="index === 0 ? 'is-older' : 'is-newer'" :style="{ '--rollup-exit-stagger': `${ Math.max(0, trailItems.length - index - 1) * 24 }ms`, '--rollup-exit-drift': `${ index % 2 ? 3 : -3 }px` }"
      >
        <span class="status-rollup__dot" :data-role="item.role" />
        <span class="status-rollup__who">{{ item.agentName }}</span>
        <span class="status-rollup__kind">{{ item.kind || 'agent' }}</span>
        <span class="status-rollup__separator">·</span>
        <span class="status-rollup__text">{{ item.text }}</span>
      </div>
    </TransitionGroup>

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
      <span class="status-rollup__text" aria-live="polite">{{ rollupText }}</span>
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
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { StatusRollupQueue, type StatusRollupItem, type StatusRollupShownEvent } from './StatusRollupQueue';
import { ToolStepClock } from '../transcript/ToolStepClock';

const props = defineProps<{
  /** Active chat-thread identifier; records for any other thread are ignored. */
  threadId: string;
  /** Check-ins already scoped by the presenter to this root and its descendants. */
  checkIns: readonly StatusRollupItem[];
  /** Current root-agent status shown when no queued check-in is visible. */
  rootFallback?: StatusRollupItem | null;
}>();

const emit = defineEmits<{
  shown: [payload: StatusRollupShownEvent];
  consumed: [];
  'consumer-attached': [];
  'consumer-detached': [];
}>();

const queue = new StatusRollupQueue();
const activityContext = inject<{ toolStepClock?: ToolStepClock } | undefined>('chat:activity-context', undefined);
const toolStepClock = activityContext ? (activityContext.toolStepClock ??= new ToolStepClock()) : new ToolStepClock();
const rootElement = ref<HTMLElement | null>(null);
const currentItem = ref<StatusRollupItem | null>(null);
const activeToolStep = ref<StatusRollupItem | null>(null);
const toolStepNow = ref(toolStepClock.nowMs);
const trailItems = ref<StatusRollupItem[]>([]);
const historyItems = ref<readonly StatusRollupItem[]>([]);
const hovered = ref(false);
const pinned = ref(false);
const documentVisible = ref(true);
const reducedMotion = ref(false);
const mounted = ref(false);
const typedText = ref('');
const dotPopping = ref(false);
let activeThreadId = '';
let timer: number | undefined;
let typingTimer: number | undefined;
let dotTimer: number | undefined;
let motionQuery: MediaQueryList | undefined;

const isPaused = computed(() => hovered.value || pinned.value || !documentVisible.value);
const fallbackItem = computed(() => props.rootFallback
  ? queue.present({ ...props.rootFallback, role: 'root' }, props.threadId, Date.now())
  : null);
const urgentCheckIn = computed(() => props.checkIns.slice().reverse().find(item =>
  item.urgency === 'needs-you' || item.urgency === 'failed') ?? null);
const displaySelection = computed(() => toolStepClock.selectDisplayItem(
  props.threadId,
  urgentCheckIn.value ?? currentItem.value ?? queue.current,
  fallbackItem.value,
  activeToolStep.value,
));
const displayItem = computed(() => {
  const selection = displaySelection.value;
  if (!selection.item || !selection.toolStep) return selection.item;
  const elapsed = toolStepClock.elapsed(selection.item, toolStepNow.value);
  return { ...selection.item, text: `${selection.item.text} · ${toolStepClock.durationLabel(elapsed)}` };
});
const rollupText = computed(() => displaySelection.value.toolStep || displaySelection.value.urgent
  ? displayItem.value?.text ?? ''
  : typedText.value);

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

const typeText = (item: StatusRollupItem, animate: boolean): void => {
  if (typingTimer !== undefined) window.clearTimeout(typingTimer);
  typingTimer = undefined;
  if (!animate || reducedMotion.value || !documentVisible.value) {
    typedText.value = item.text;
    return;
  }
  typedText.value = '';
  const characters = Array.from(item.text);
  let count = 0;
  const typeNext = (): void => {
    count = Math.min(characters.length, count + 1);
    typedText.value = characters.slice(0, count).join('');
    if (count < characters.length) typingTimer = window.setTimeout(typeNext, 13);
    else typingTimer = undefined;
  };
  typeNext();
};

const showItem = (item: StatusRollupItem | null, fromQueue = false, animateText = fromQueue): void => {
  const previous = currentItem.value;
  if (previous?.key === item?.key) {
    if (item && previous.text !== item.text) { currentItem.value = item; typeText(item, animateText); }
    return;
  }
  if (previous && item) {
    const newestFirst = [previous, ...trailItems.value.slice().reverse()].slice(0, 2);
    trailItems.value = newestFirst.reverse();
  }
  currentItem.value = item;
  if (item) {
    typeText(item, animateText);
    if (dotTimer !== undefined && typeof window !== 'undefined') window.clearTimeout(dotTimer);
    dotPopping.value = fromQueue && !reducedMotion.value;
    if (fromQueue && typeof window !== 'undefined') {
      dotTimer = window.setTimeout(() => { dotPopping.value = false; dotTimer = undefined; }, 160);
    } else {
      dotTimer = undefined;
    }
    if (fromQueue) emitShown(item);
  } else {
    typedText.value = '';
    dotPopping.value = false;
  }
};

const refresh = (): void => {
  const now = Date.now();
  const shownItems = queue.pumpDue(now, isPaused.value);
  const animateText = queue.shouldAnimateTypewriter(shownItems.length);
  if (shownItems.length) shownItems.forEach(item => showItem(item, true, animateText));
  else showItem(queue.current ?? fallbackItem.value);
  historyItems.value = queue.history;
};

const syncInput = (): void => {
  const now = Date.now();
  const threadChanged = activeThreadId !== props.threadId;
  if (threadChanged) {
    activeThreadId = props.threadId;
    toolStepClock.reset();
    activeToolStep.value = null;
    queue.reset(activeThreadId);
    showItem(null);
    trailItems.value = [];
    historyItems.value = [];
    pinned.value = false;
    hovered.value = false;
  }

  toolStepClock.observe([...props.checkIns, ...(props.rootFallback ? [props.rootFallback] : [])]);
  activeToolStep.value = toolStepClock.currentStep(props.threadId);

  const visible = currentItem.value ?? queue.current ?? fallbackItem.value;
  queue.observe(props.checkIns, props.threadId, now, visible);
  if (props.checkIns.length) emit('consumed');
  if (threadChanged && !mounted.value) {
    const seeded = queue.seed(props.checkIns, props.threadId, now);
    if (seeded) showItem(seeded);
  }
  historyItems.value = queue.history;
  if (mounted.value) refresh();
};

watch(activeToolStep, (step, _, onCleanup) => {
  toolStepNow.value = toolStepClock.nowMs;
  if (step) onCleanup(toolStepClock.subscribe(now => { toolStepNow.value = now; }));
}, { immediate: true });

watch(toolStepNow, () => {
  activeToolStep.value = toolStepClock.currentStep(props.threadId);
});

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
  if (reducedMotion.value && currentItem.value) {
    if (typingTimer !== undefined) window.clearTimeout(typingTimer);
    typingTimer = undefined;
    typedText.value = currentItem.value.text;
    dotPopping.value = false;
  }
};

watch(
  () => [props.threadId, props.checkIns, props.rootFallback] as const,
  syncInput,
  { deep: true, immediate: true },
);

onMounted(() => {
  emit('consumer-attached');
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
  emit('consumer-detached');
  mounted.value = false;
  hovered.value = false;
  if (timer !== undefined) window.clearInterval(timer);
  if (typingTimer !== undefined) window.clearTimeout(typingTimer);
  if (dotTimer !== undefined) window.clearTimeout(dotTimer);
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

.status-rollup__trail {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  width: min(470px, 100%);
  height: 44px;
  overflow: hidden;
}

.status-rollup__trail-item {
  display: flex;
  align-items: center;
  flex: none;
  gap: 7px;
  height: 22px;
  min-width: 0;
  line-height: 22px;
  font-size: 12.5px;
  white-space: nowrap;
}

.status-rollup__trail-item.is-older { opacity: .3; }
.status-rollup__trail-item.is-newer { opacity: .6; }
.status-rollup__trail-item .status-rollup__who { max-width: 105px; font-size: 12.5px; }
.status-rollup__trail-item .status-rollup__kind,
.status-rollup__trail-item .status-rollup__separator { font-size: 11px; }
.status-rollup__trail-item .status-rollup__text { font-size: 12.5px; }

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

.rollup-trail-move {
  transition: transform 420ms cubic-bezier(.22, 1, .36, 1), opacity 700ms cubic-bezier(.22, 1, .36, 1);
}

.rollup-trail-enter-active,
.rollup-trail-leave-active {
  transition: transform 420ms cubic-bezier(.22, 1, .36, 1), opacity 700ms cubic-bezier(.22, 1, .36, 1);
}

.rollup-trail-enter-from { opacity: 0; transform: translateY(22px); }
.rollup-trail-leave-to { opacity: 0; transform: translateY(-22px) translateX(var(--rollup-exit-drift, 0px)); }
.rollup-trail-leave-active { position: absolute; left: 0; right: 0; transition-delay: var(--rollup-exit-stagger, 0ms), 0ms; }

.rollup-history-enter-active,
.rollup-history-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.rollup-history-enter-from,
.rollup-history-leave-to {
  opacity: 0;
  transform: translateY(5px);
}

.is-document-hidden .rollup-trail-move,
.is-document-hidden .rollup-trail-enter-active,
.is-document-hidden .rollup-trail-leave-active,
.is-document-hidden .rollup-history-enter-active,
.is-document-hidden .rollup-history-leave-active {
  transition: none;
}

.is-reduced-motion .rollup-trail-move,
.is-reduced-motion .rollup-trail-enter-active,
.is-reduced-motion .rollup-trail-leave-active,
.is-reduced-motion .rollup-history-enter-active,
.is-reduced-motion .rollup-history-leave-active {
  transition: opacity 160ms ease;
}

.is-reduced-motion .rollup-trail-enter-from,
.is-reduced-motion .rollup-trail-leave-to,
.is-reduced-motion .rollup-history-enter-from,
.is-reduced-motion .rollup-history-leave-to {
  transform: none;
}

@media (prefers-reduced-motion: reduce) {
  .rollup-trail-move,
  .rollup-trail-enter-active,
  .rollup-trail-leave-active,
  .rollup-history-enter-active,
  .rollup-history-leave-active { transition: opacity 160ms ease; }
  .rollup-trail-enter-from,
  .rollup-trail-leave-to,
  .rollup-history-enter-from,
  .rollup-history-leave-to { transform: none; }
}
</style>
