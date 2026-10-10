<template>
  <nav
    ref="rail"
    :class="['mode-rail', { expanded }]"
    aria-label="Mode switcher"
  >
    <div
      ref="itemList"
      class="rail-items"
    >
      <span
        class="active-indicator"
        :class="{ visible: indicatorVisible }"
        :style="indicatorStyle"
        aria-hidden="true"
      />

      <template
        v-for="(item, idx) in items"
        :key="`${item.mode}:${item.subTab ?? ''}`"
      >
        <div
          v-if="item.groupStart"
          class="rail-divider"
          aria-hidden="true"
        />
        <button
          :ref="element => setItemRef(element, idx)"
          type="button"
          :class="['mode-btn', { active: isActive(item, idx) }]"
          :data-tooltip="item.mode === 'decide' && pending.length ? `Decide · ${pending.length} waiting` : (item.tooltip ?? item.label)"
          :aria-label="item.label"
          :aria-current="isActive(item, idx) ? 'page' : undefined"
          @click="$emit('set-mode', item.mode, item.subTab)"
        >
          <span
            class="icon"
            v-html="item.icon"
          />
          <span
            v-if="item.mode === 'decide' && pending.length"
            class="decision-badge"
            :aria-label="`${pending.length} decisions waiting`"
          >{{ pending.length }}</span>
          <span class="item-label">{{ item.label }}</span>
          <span
            class="shortcut-hint"
            aria-hidden="true"
          >{{ item.shortcut }}</span>
        </button>
      </template>
    </div>

    <div class="rail-spacer" />

    <div class="rail-footer">
      <button
        type="button"
        :class="['mode-btn', { active: bookmarksOpen }]"
        data-tooltip="Bookmarks (⌘⇧B)"
        aria-label="Bookmarks"
        :aria-pressed="bookmarksOpen"
        @click="$emit('toggle-bookmarks')"
      >
        <span class="icon">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M18.5 20.5L12 16l-6.5 4.5V5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2z" />
          </svg>
        </span>
        <span class="item-label">Bookmarks</span>
      </button>

      <button
        type="button"
        :class="['mode-btn', { active: fileTreeOpen }]"
        data-tooltip="File Explorer"
        aria-label="File Explorer"
        :aria-pressed="fileTreeOpen"
        @click="$emit('toggle-file-tree')"
      >
        <span class="icon">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <path d="M9 12h6M9 15h4" />
          </svg>
        </span>
        <span class="item-label">File Explorer</span>
      </button>

      <button
        type="button"
        class="mode-btn expand-toggle"
        :data-tooltip="expanded ? 'Collapse rail' : 'Expand rail'"
        :aria-label="expanded ? 'Collapse mode rail' : 'Expand mode rail'"
        :aria-expanded="expanded"
        @click="toggleExpanded"
      >
        <span class="icon expand-icon">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <rect
              x="3"
              y="4"
              width="18"
              height="16"
              rx="4"
            />
            <path d="M9 4v16M13.5 10l2 2-2 2" />
          </svg>
        </span>
        <span class="item-label">{{ expanded ? 'Collapse' : 'Expand' }}</span>
      </button>

      <div
        class="rail-profile"
        aria-label="Jonathon"
      >
        <span
          class="profile-avatar"
          aria-hidden="true"
        >J</span>
        <span class="profile-label">Jonathon</span>
      </div>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useDecisions } from '@pkg/composables/useDecisions';

import type { ComponentPublicInstance, CSSProperties } from 'vue';

const EXPANDED_STORAGE_KEY = 'sulla:mode-rail-expanded';

const { pending } = useDecisions();
const props = defineProps<{
  active?:        string;
  activeSubTab?:  string;
  fileTreeOpen?:  boolean;
  bookmarksOpen?: boolean;
}>();

defineEmits<{
  (e: 'set-mode', mode: string, subTab?: string): void;
  (e: 'toggle-file-tree'): void;
  (e: 'toggle-bookmarks'): void;
}>();

interface ModeItem {
  mode:        string;
  label:       string;
  icon:        string;
  shortcut:    string;
  subTab?:     string;
  tooltip?:    string;
  groupStart?: boolean;
}

const rail = ref<HTMLElement>();
const itemList = ref<HTMLElement>();
const itemRefs = new Map<number, HTMLButtonElement>();
const expanded = ref(readExpandedPreference());
const indicatorTop = ref(0);
const indicatorHeight = ref(40);
const indicatorVisible = ref(false);
let resizeObserver: ResizeObserver | undefined;

const indicatorStyle = computed<CSSProperties>(() => ({
  height:    `${ indicatorHeight.value }px`,
  transform: `translateY(${ indicatorTop.value }px)`,
}));

function readExpandedPreference(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function setItemRef(element: Element | ComponentPublicInstance | null, idx: number): void {
  if (element instanceof HTMLButtonElement) {
    itemRefs.set(idx, element);
  } else {
    itemRefs.delete(idx);
  }
}

function isActive(item: ModeItem, idx: number): boolean {
  if (item.mode !== props.active) return false;
  if (item.subTab && props.activeSubTab) return item.subTab === props.activeSubTab;

  return items.findIndex(candidate => candidate.mode === props.active) === idx;
}

function updateIndicator(): void {
  const activeIdx = items.findIndex((item, idx) => isActive(item, idx));
  const activeButton = itemRefs.get(activeIdx);

  if (!activeButton || !itemList.value) {
    indicatorVisible.value = false;

    return;
  }

  indicatorTop.value = activeButton.offsetTop;
  indicatorHeight.value = activeButton.offsetHeight || 40;
  indicatorVisible.value = true;
}

function scheduleIndicatorUpdate(): void {
  nextTick(() => requestAnimationFrame(updateIndicator));
}

function toggleExpanded(): void {
  expanded.value = !expanded.value;
  try {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, String(expanded.value));
  } catch {
    // A locked-down renderer can deny storage; expansion still works for this session.
  }
  scheduleIndicatorUpdate();
}

watch(() => [props.active, props.activeSubTab], scheduleIndicatorUpdate, { flush: 'post' });

onMounted(() => {
  scheduleIndicatorUpdate();
  window.addEventListener('resize', scheduleIndicatorUpdate);
  if (typeof ResizeObserver !== 'undefined' && rail.value) {
    resizeObserver = new ResizeObserver(scheduleIndicatorUpdate);
    resizeObserver.observe(rail.value);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleIndicatorUpdate);
  resizeObserver?.disconnect();
});

const items: readonly ModeItem[] = Object.freeze([
  {
    mode: 'decide', label: 'Decide', shortcut: '⌘1', tooltip: 'Decide', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M9 12l2 2 4-4"/></svg>',
  },
  {
    mode: 'chat', label: 'Chat', shortcut: '⌘2', icon: '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></svg>',
  },
  {
    mode: 'browser', label: 'Browser', shortcut: '⌘3', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19z"/></svg>',
  },
  {
    mode: 'agents', label: 'Agents', shortcut: '⌘4', icon: '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
  },
  {
    mode: 'projects', label: 'Projects', shortcut: '⌘5', icon: '<svg viewBox="0 0 24 24"><rect x="2.5" y="7" width="19" height="13.5" rx="3"/><path d="M8.5 7V5.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2V7"/></svg>',
  },
  {
    mode: 'routines', subTab: 'mywork', label: 'Routines', shortcut: '⌘6', groupStart: true, icon: '<svg viewBox="0 0 24 24"><path d="M20.5 12a8.5 8.5 0 0 1-14.8 5.7M3.5 12A8.5 8.5 0 0 1 18.3 6.3"/><path d="M19 3v4h-4M5 21v-4h4"/></svg>',
  },
  {
    mode: 'secretary', label: 'Secretary', shortcut: '⌘7', tooltip: 'Secretary · ⌘⇧S', icon: '<svg viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg>',
  },
  {
    mode: 'routines', subTab: 'library', label: 'Library', shortcut: '⌘8', icon: '<svg viewBox="0 0 24 24"><path d="M4 4.5h4v15H4zM10 4.5h4v15h-4zM15.5 5.5l3.6-1 3 14.4-3.6 1z"/></svg>',
  },
  {
    mode: 'marketplace', label: 'Marketplace', shortcut: '⌘9', icon: '<svg viewBox="0 0 24 24"><path d="M5 8h14l-1.2 12H6.2z"/><path d="M9 8a3 3 0 0 1 6 0"/></svg>',
  },
  {
    mode: 'vault', label: 'Password Vault', shortcut: '⌘0', groupStart: true, icon: '<svg viewBox="0 0 24 24"><rect x="4.5" y="10.5" width="15" height="10" rx="3"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>',
  },
]);
</script>

<style scoped>
.mode-rail {
  --rail-spring: linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1);
  --rail-standard: cubic-bezier(.22, 1, .36, 1);

  box-sizing: border-box;
  width: 64px;
  height: 100%;
  display: flex;
  flex: none;
  flex-direction: column;
  padding: 40px 10px 10px;
  overflow: visible;
  color: var(--read-3, #a9b3c1);
  background: rgba(3, 6, 12, .55);
  border-right: 1px solid rgba(168, 192, 220, .08);
  backdrop-filter: blur(10px);
  transition: width .58s var(--rail-spring);
  z-index: 20;
}

.mode-rail.expanded {
  width: 212px;
}

.rail-items,
.rail-footer {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.active-indicator {
  position: absolute;
  inset: 0 0 auto;
  border-radius: 20px;
  pointer-events: none;
  opacity: 0;
  background: linear-gradient(180deg, rgba(80, 150, 179, .30), rgba(80, 150, 179, .14));
  box-shadow: inset 0 0 0 .5px rgba(106, 176, 204, .5), 0 0 22px rgba(80, 150, 179, .22);
  transition: transform .58s var(--rail-spring), opacity .12s ease;
  z-index: 0;
}

.active-indicator.visible {
  opacity: 1;
}

.active-indicator::before {
  content: '';
  position: absolute;
  left: -10px;
  top: 50%;
  width: 3px;
  height: 22px;
  margin-top: -11px;
  border-radius: 0 3px 3px 0;
  background: var(--steel-400, #6ab0cc);
  box-shadow: 0 0 10px var(--steel-400, #6ab0cc);
}

.mode-btn {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 40px;
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0 12px;
  overflow: visible;
  border: 0;
  border-radius: 20px;
  color: var(--read-3, #a9b3c1);
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  transition: color .16s var(--rail-standard), background .16s var(--rail-standard), transform .5s var(--rail-spring);
}

.mode-btn:hover {
  color: var(--read-2, #dee4ec);
  background: rgba(80, 150, 179, .10);
}

.mode-btn:active {
  transform: scale(.92);
  transition-duration: .08s;
}

.mode-btn:focus-visible {
  outline: 2px solid var(--steel-400, #6ab0cc);
  outline-offset: 2px;
}

.mode-btn.active {
  color: #fff;
}

.expanded .mode-btn {
  gap: 12px;
}

.rail-footer .mode-btn.active {
  background: rgba(80, 150, 179, .14);
}

.icon {
  width: 20px;
  height: 20px;
  display: grid;
  flex: none;
  place-items: center;
}

.icon :deep(svg) {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.mode-btn.active .icon {
  filter: drop-shadow(0 0 8px rgba(106, 176, 204, .6));
}

.item-label,
.profile-label {
  max-width: 0;
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 500;
  opacity: 0;
  filter: blur(6px);
  transform: translateX(-6px);
  transition: opacity .24s var(--rail-standard), filter .24s var(--rail-standard), transform .48s var(--rail-spring);
}

.expanded .item-label,
.expanded .profile-label {
  max-width: 120px;
  opacity: 1;
  filter: blur(0);
  transform: none;
}

.shortcut-hint {
  display: none;
  margin-left: auto;
  color: var(--read-5, #484f5a);
  font-family: var(--mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace);
  font-size: 10.5px;
  opacity: 0;
  transition: opacity .2s ease;
}

.expanded .shortcut-hint {
  display: inline;
  opacity: 1;
}

.rail-divider {
  height: 1px;
  margin: 6px 8px;
  flex: none;
  background: rgba(168, 192, 220, .08);
}

.decision-badge {
  position: absolute;
  left: 25px;
  top: 3px;
  min-width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  padding: 0 4px;
  border-radius: 8px;
  color: #fff;
  background: var(--steel-500, #5096b3);
  box-shadow: 0 0 8px var(--steel-500, #5096b3), 0 0 0 2px var(--ink-2, #03060c);
  font-size: 10px;
  font-weight: 650;
}

.decision-badge::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--steel-400, #6ab0cc);
  animation: decision-ping 2.2s var(--rail-standard) infinite;
  z-index: -1;
}

@keyframes decision-ping {
  0% { transform: scale(1); opacity: .6; }
  70%, 100% { transform: scale(2.2); opacity: 0; }
}

.rail-spacer {
  flex: 1;
  min-height: 8px;
}

.mode-btn::after {
  content: attr(data-tooltip);
  position: absolute;
  left: 52px;
  top: 50%;
  padding: 6px 10px;
  border: 1px solid rgba(168, 192, 220, .18);
  border-radius: 8px;
  color: var(--read-1, #f3f5f8);
  background: rgba(12, 18, 28, .96);
  box-shadow: 0 6px 22px rgba(0, 0, 0, .55);
  font-family: var(--mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace);
  font-size: 11px;
  letter-spacing: .08em;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transform: translate(-4px, -50%) scale(.96);
  transition: opacity .14s var(--rail-standard), transform .3s var(--rail-spring);
  z-index: 1000;
}

.mode-rail:not(.expanded) .mode-btn:hover::after {
  opacity: 1;
  transform: translate(0, -50%) scale(1);
  transition-delay: .25s;
}

.expanded .mode-btn::after {
  display: none;
}

.expand-icon {
  transition: transform .48s var(--rail-spring);
}

.expanded .expand-icon {
  transform: scaleX(-1);
}

.rail-profile {
  height: 44px;
  display: flex;
  align-items: center;
  gap: 0;
  padding-left: 2px;
  margin-top: 8px;
  overflow: hidden;
}

.profile-avatar {
  width: 40px;
  height: 40px;
  display: grid;
  flex: none;
  place-items: center;
  border-radius: 20px;
  color: var(--read-2, #dee4ec);
  background: conic-gradient(from 215deg, #1b2433, #2c3a50, #151d2a, #26344a, #1b2433);
  box-shadow: inset 0 0 0 1px rgba(168, 192, 220, .16);
  font-size: 13px;
  font-weight: 600;
}

.profile-label {
  color: var(--read-1, #f3f5f8);
}

.expanded .rail-profile {
  gap: 10px;
}

@media (prefers-reduced-motion: reduce) {
  .mode-rail,
  .active-indicator,
  .mode-btn,
  .item-label,
  .profile-label,
  .shortcut-hint,
  .expand-icon {
    transition: none;
  }

  .item-label,
  .profile-label {
    filter: none;
  }

  .decision-badge::after {
    animation: none;
  }
}
</style>
