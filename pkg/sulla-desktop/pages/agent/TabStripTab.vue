<!-- Sulla Desktop · https://sulladesktop.com
     Copyright (c) 2025-2026 Merchant Protocol LLC.
     SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <router-link
    :to="tab.route"
    draggable="false"
    class="tab-item text-sm md:text-base"
    :data-tab-id="tab.id"
    :data-tab-index="index"
    :data-active="tab.isActive ? 'true' : undefined"
    :class="[
      tab.mode ? `tab-mode-${tab.mode}` : '',
      {
        'tab-native': tab.native,
        'tab-active': tab.isActive && !tab.native,
        'tab-active-native': tab.isActive && tab.native,
        'tab-inactive': !tab.isActive,
        'tab-pinned': tab.pinned,
        'tab-pinned-boundary': pinnedBoundary,
        'tab-working': tab.working || tab.activity === 'working',
        'tab-pointer-dragging': dragging,
        'tab-preview': tab.preview,
        'tab-busy': tab.working || ['you', 'stalled', 'working', 'waiting'].includes(tab.activity ?? ''),
        'tab-idle': !renaming && !tab.working && (!tab.activity || tab.activity === 'idle' || tab.activity === 'quiet'),
        'tab-compact': compact,
        'tab-size-icon': iconOnly,
      },
    ]"
    :aria-label="accessibleLabel"
    @pointerdown="onPointerDown($event, index)"
    @pointerenter="emit('hover', $event, tab)"
    @pointerleave="emit('hoverEnd')"
    @dragstart.prevent
    @dblclick="tab.browserId && emit('promote', tab.browserId)"
    @auxclick.prevent="emit('auxclick', $event, tab)"
    @contextmenu.prevent="emit('contextmenu', $event, tab)"
  >
    <span class="tab-accent-bar" />
    <svg
      v-if="tab.pinned"
      class="tab-pin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      role="img"
      aria-label="Pinned"
    >
      <path d="M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4" />
      <path d="M9 15l-4.5 4.5" />
      <path d="M14.5 4l5.5 5.5" />
    </svg>
    <span class="tab-icon">
      <span
        v-if="tab.working || tab.activity === 'working'"
        class="tab-status tab-status-working tab-icon-meter"
        role="img"
        :aria-label="activityLabels.working"
      >
        <svg
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          aria-hidden="true"
        ><path d="M2 5v4" /><path d="M6 2v7" /><path d="M10 4v5" /></svg>
      </span>
      <img
        v-else-if="tab.favicon"
        :src="tab.favicon"
        draggable="false"
        class="tab-favicon-img"
        alt=""
      >
      <svg
        v-else
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="tab-favicon-svg"
      ><path :d="tab.iconPath || GENERIC_TAB_ICON_PATH" /></svg>
      <span
        v-if="tab.activity && tab.activity !== 'idle' && tab.activity !== 'working'"
        class="tab-activity-dot"
        :class="`tab-activity-${tab.activity}`"
        role="img"
        :aria-label="activityLabels[tab.activity] || tab.activity"
      />
    </span>
    <input
      v-if="renaming"
      ref="renameInput"
      class="tab-rename"
      type="text"
      maxlength="80"
      aria-label="Tab name"
      :value="renameDraft"
      :placeholder="tab.pageTitle"
      @pointerdown.stop
      @click.stop.prevent
      @dblclick.stop
      @input="emit('update:renameDraft', ($event.target as HTMLInputElement).value)"
      @keydown.enter.prevent="emit('commitRename')"
      @keydown.esc.prevent="emit('cancelRename')"
      @blur="emit('renameBlur')"
    >
    <span
      v-else
      ref="labelElement"
      class="tab-label"
      :class="{ 'tab-label-overflowing': labelOverflows }"
    >{{ tab.label }}</span>
    <span
      v-if="tab.closeable"
      class="tab-close-spacer"
      aria-hidden="true"
    />
    <button
      v-if="tab.closeable"
      class="tab-close"
      type="button"
      aria-label="Close tab"
      @click.prevent.stop="emit('close', tab)"
      @pointerdown.stop
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        class="h-2.5 w-2.5 md:h-3 md:w-3"
      ><path d="M18 6L6 18M6 6l12 12" /></svg>
    </button>
  </router-link>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { BrowserTabMode } from '@pkg/composables/useBrowserTabs';
import type { ThreadActivityState } from '@pkg/pages/chat/messages/threadActivity';

interface TabStripTabData {
  id:         string;
  label:      string;
  route:      string;
  isActive:   boolean;
  pinned:     boolean;
  working:    boolean;
  activity?:  ThreadActivityState;
  statusLine: string;
  native?:    boolean;
  favicon?:   string;
  iconPath?:  string;
  mode?:      BrowserTabMode;
  closeable?: boolean;
  browserId?: string;
  preview?:   boolean;
  pageTitle?: string;
}

const props = defineProps<{
  tab:            TabStripTabData;
  index:          number;
  pinnedBoundary: boolean;
  dragging:       boolean;
  renaming:       boolean;
  renameDraft:    string;
  activityLabels: Record<ThreadActivityState, string>;
  compact?:       boolean;
  iconOnly?:      boolean;
}>();

const emit = defineEmits<{
  pointerdown:          [event: PointerEvent, index: number];
  hover:                [event: PointerEvent, tab: TabStripTabData];
  hoverEnd:             [];
  promote:              [browserId: string];
  auxclick:             [event: MouseEvent, tab: TabStripTabData];
  contextmenu:          [event: MouseEvent, tab: TabStripTabData];
  close:                [tab: TabStripTabData];
  'update:renameDraft': [value: string];
  commitRename:         [];
  cancelRename:         [];
  renameBlur:           [];
}>();

const renameInput = ref<HTMLInputElement | null>(null);
const labelElement = ref<HTMLSpanElement | null>(null);
const labelOverflows = ref(false);
let labelResizeObserver: ResizeObserver | null = null;
const GENERIC_TAB_ICON_PATH = 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5';
function onPointerDown(event: PointerEvent, index: number): void {
  if (!props.compact) emit('pointerdown', event, index);
}

const accessibleLabel = computed(() => [
  props.tab.label,
  props.tab.activity && props.tab.activity !== 'idle' ? props.activityLabels[props.tab.activity] : '',
  props.tab.pinned ? 'Pinned' : '',
].filter(Boolean).join(' · '));

function measureLabelOverflow(): void {
  const label = labelElement.value;
  const overflows = Boolean(label && label.scrollWidth > label.clientWidth + 1);
  if (labelOverflows.value !== overflows) labelOverflows.value = overflows;
}

function observeLabel(): void {
  labelResizeObserver?.disconnect();
  const label = labelElement.value;
  if (!label) {
    labelOverflows.value = false;
    return;
  }
  labelResizeObserver?.observe(label);
  measureLabelOverflow();
}

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    labelResizeObserver = new ResizeObserver(measureLabelOverflow);
  } else {
    window.addEventListener('resize', measureLabelOverflow);
  }
  observeLabel();
});

watch(() => [props.tab.label, props.renaming] as const, observeLabel, { flush: 'post' });

onBeforeUnmount(() => {
  labelResizeObserver?.disconnect();
  labelResizeObserver = null;
  if (typeof window !== 'undefined') window.removeEventListener('resize', measureLabelOverflow);
});

watch(() => props.renaming, async(isRenaming) => {
  if (!isRenaming) return;
  await nextTick();
  const input = renameInput.value;
  if (!input || input.getBoundingClientRect().width === 0) return;
  input.focus();
  input.select();
}, { flush: 'post' });
</script>
