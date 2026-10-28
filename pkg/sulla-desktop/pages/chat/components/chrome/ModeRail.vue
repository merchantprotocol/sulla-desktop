<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
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
          :data-tooltip="item.label"
          :data-noir-tooltip="item.mode === 'decide' && pending.length ? `Decide · ${pending.length} waiting` : (item.tooltip ?? item.label)"
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

      <template v-if="safeExtensions.length">
        <div class="rail-divider" aria-hidden="true" />
        <button
          v-for="item in safeExtensions"
          :key="`extension:${item.extensionId}:${item.id}`"
          type="button"
          class="mode-btn extension-btn"
          :data-tooltip="item.tooltip"
          :data-noir-tooltip="item.tooltip"
          :aria-label="item.tooltip"
          @click="$emit('open-extension', item)"
          @contextmenu.prevent="openExtensionMenu($event, item)"
        >
          <span class="icon" v-html="item.icon" />
          <span class="item-label">{{ item.label }}</span>
        </button>
      </template>

      <template v-if="safeRailApps.length">
        <div
          class="rail-divider"
          aria-hidden="true"
        />
        <button
          v-for="app in safeRailApps"
          :key="`recipe:${app.slug}`"
          type="button"
          :class="['mode-btn', 'recipe-app-btn', `status-${app.level}`]"
          :data-tooltip="app.tooltip"
          :data-noir-tooltip="app.tooltip"
          :aria-label="app.tooltip"
          @click="$emit('open-rail-app', app.slug)"
        >
          <span
            class="icon"
            v-html="app.icon"
          />
          <span class="item-label">{{ app.label }}</span>
        </button>
      </template>
    </div>

    <div v-if="extensionMenu" class="extension-menu" :style="{ left: `${extensionMenu.x}px`, top: `${extensionMenu.y}px` }" role="menu">
      <small>{{ extensionMenu.item.label }}</small>
      <button type="button" @click="chooseExtensionMenu('open')">Open</button>
      <button type="button" @click="chooseExtensionMenu('permissions')">Permissions…</button>
      <button type="button" class="remove" @click="chooseExtensionMenu('remove')">Remove from left bar</button>
    </div>

    <div class="rail-spacer" />

    <div class="rail-footer">
      <button
        v-if="active === 'chat'"
        type="button"
        :class="['mode-btn', { active: chatFilesOpen }]"
        data-tooltip="File Explorer"
        aria-label="File Explorer"
        :aria-pressed="chatFilesOpen"
        @click="$emit('toggle-chat-files')"
      >
        <span class="icon">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        </span>
        <span class="item-label">File Explorer</span>
      </button>

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
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </span>
        <span class="item-label">Bookmarks</span>
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
    </div>
  </nav>
</template>

<script setup lang="ts">
import DOMPurify from 'dompurify';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useDecisions } from '@pkg/composables/useDecisions';

import type { ComponentPublicInstance, CSSProperties } from 'vue';

const EXPANDED_STORAGE_KEY = 'sulla:mode-rail-expanded';

const { pending } = useDecisions();
const props = defineProps<{
  active?:        string;
  activeSubTab?:  string;
  bookmarksOpen?: boolean;
  chatFilesOpen?: boolean;
  railApps?:      RecipeRailApp[];
  extensions?:    ExtensionRailItem[];
}>();

const emit = defineEmits<{
  (e: 'set-mode', mode: string, subTab?: string): void;
  (e: 'toggle-bookmarks'): void;
  (e: 'toggle-chat-files'): void;
  (e: 'open-rail-app', slug: string): void;
  (e: 'open-extension', item: ExtensionRailItem): void;
  (e: 'extension-permissions', item: ExtensionRailItem): void;
  (e: 'remove-extension', item: ExtensionRailItem): void;
}>();

interface ExtensionRailItem { extensionId:string; id:string; label:string; icon?:string; component:string; tooltip?:string }

interface RecipeRailApp {
  slug:    string;
  label:   string;
  icon:    string;
  level:   'ok' | 'warn' | 'bad' | 'unknown';
  summary: string;
}

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

const FALLBACK_EXTENSION_ICON = '<svg viewBox="0 0 24 24"><path d="M8 3v4M16 3v4M5 8h14v5a7 7 0 0 1-14 0z"/><path d="M12 20v2"/></svg>';
const extensionMenu = ref<{x:number;y:number;item:ExtensionRailItem}>();
const safeExtensions = computed(() => (props.extensions ?? []).map(item => ({ ...item, tooltip: item.tooltip || item.label, icon: DOMPurify.sanitize(item.icon || FALLBACK_EXTENSION_ICON, { USE_PROFILES:{svg:true,svgFilters:false}, FORBID_TAGS:['script','style','foreignObject'], FORBID_ATTR:['style','href','xlink:href','src'] }) })));
function openExtensionMenu(event:MouseEvent,item:ExtensionRailItem){ extensionMenu.value={x:event.clientX,y:event.clientY,item}; }
function chooseExtensionMenu(action:'open'|'permissions'|'remove'){ const item=extensionMenu.value?.item;if(!item)return; extensionMenu.value=undefined; if(action==='open') (emit as any)('open-extension',item); else if(action==='permissions') (emit as any)('extension-permissions',item); else (emit as any)('remove-extension',item); }

const safeRailApps = computed(() => (props.railApps ?? []).map(app => ({
  ...app,
  tooltip: app.summary ? `${ app.label } · ${ app.summary }` : app.label,
  icon: DOMPurify.sanitize(app.icon, {
    USE_PROFILES: { svg: true, svgFilters: false },
    FORBID_TAGS:  ['script', 'style', 'foreignObject', 'iframe', 'object', 'embed'],
    FORBID_ATTR:  ['style', 'href', 'xlink:href', 'src'],
  }),
})));

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
    mode: 'decide', label: 'Decide', shortcut: '⌘1', tooltip: 'Decide', icon: '<svg viewBox="0 0 24 24"><path d="M9 12l2 2 4-4"/><rect x="3" y="3" width="18" height="18" rx="4"/></svg>',
  },
  {
    mode: 'chat', label: 'Chat', shortcut: '⌘2', icon: '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
  },
  {
    mode: 'browser', label: 'Browser', shortcut: '⌘3', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  },
  {
    mode: 'marketplace', subTab: 'usage', label: 'Token Usage', shortcut: '⌘U', icon: '<svg viewBox="0 0 24 24"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V3"/><path d="M2 19h20"/></svg>',
  },
  {
    mode: 'files', label: 'Files', shortcut: '⌘⇧F', icon: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 12h8M8 16h5"/></svg>',
  },
  {
    mode: 'routines', subTab: 'workflows', label: 'Workflows', shortcut: '⌘6', groupStart: true, icon: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3.2-6.8"/><polyline points="21 3.5 21 9 15.5 9"/></svg>',
  },
  {
    mode: 'secretary', label: 'Secretary', shortcut: '⌘7', tooltip: 'Secretary · ⌘⇧S', icon: '<svg viewBox="0 0 24 24"><path d="M12 2v4"/><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 1 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>',
  },
  {
    mode: 'marketplace', subTab: 'browse', label: 'Use Cases', shortcut: '⌘9', icon: '<svg viewBox="0 0 24 24"><path d="M3 7l1-4h16l1 4"/><path d="M3 7v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7"/><path d="M3 7h18"/><path d="M8 11a4 4 0 0 0 8 0"/></svg>',
  },
  {
    mode: 'vault', label: 'Password Vault', shortcut: '⌘0', groupStart: true, icon: '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  },
]);
</script>

<style scoped>
.mode-rail {
  width: 52px;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 40px 0 10px;
  background: rgba(3, 6, 12, .55);
  border-right: 1px solid rgba(168, 192, 220, .08);
  backdrop-filter: blur(10px);
  flex-shrink: 0;
  gap: 4px;
  overflow-x: visible;
  overflow-y: auto;
  scrollbar-width: none;
}

.mode-rail::-webkit-scrollbar { display: none; }

.rail-items,
.rail-footer {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.active-indicator {
  display: none;
}

.mode-btn {
  position: relative;
  margin: 0 6px;
  padding: 8px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  color: #a9b3c1;
  background: transparent;
  cursor: pointer;
  transition: color .2s ease, background .2s ease;
}

.mode-btn:hover {
  color: #dee4ec;
  background: rgba(80, 150, 179, .12);
}

.mode-btn.active {
  color: white;
  background: rgba(80, 150, 179, .14);
}

.mode-btn.active::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 50%;
  width: 3px;
  height: 26px;
  border-radius: 0 3px 3px 0;
  background: var(--steel-400);
  box-shadow: 0 0 10px var(--steel-400);
  transform: translateY(-50%);
}

.icon {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: filter .2s ease, transform .15s ease;
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

.mode-btn:hover .icon {
  transform: translateY(-1px);
}

.mode-btn.active .icon {
  filter: drop-shadow(0 0 10px rgba(106, 176, 204, .45));
}

.item-label,
.shortcut-hint {
  display: none;
}

.rail-divider {
  display: none;
}

.decision-badge {
  position: absolute;
  top: 0;
  right: 0;
  padding: 1px 5px;
  border-radius: 12px;
  color: white;
  background: var(--accent, #5096b3);
  box-shadow: 0 0 8px var(--accent, #5096b3);
  font-size: 10px;
}

.rail-spacer {
  flex: 1;
  min-height: 8px;
}

.mode-btn::after {
  content: attr(data-tooltip);
  position: absolute;
  left: calc(100% + 10px);
  top: 50%;
  padding: 5px 10px;
  border: 1px solid rgba(168, 192, 220, .18);
  border-radius: 5px;
  color: var(--read-1, #e6edf3);
  background: rgba(12, 18, 28, .96);
  box-shadow: 0 6px 22px rgba(0, 0, 0, .55);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: .08em;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transform: translateY(-50%) translateX(-4px);
  transition: opacity .12s ease, transform .12s ease;
  z-index: 1000;
}

.mode-btn:hover::after {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}

.expand-toggle {
  display: none;
}

.theme-noir .mode-rail {
  --rail-spring: linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1) .58s;
  box-sizing: border-box;
  width: 64px;
  padding: 40px 10px 10px;
  overflow: visible;
  color: var(--nx-read-3);
  transition: width var(--rail-spring);
  z-index: 20;
}

.theme-noir .mode-rail.expanded {
  width: 212px;
}

.theme-noir .rail-items,
.theme-noir .rail-footer {
  position: relative;
}

.theme-noir .active-indicator {
  position: absolute;
  inset: 0 0 auto;
  display: block;
  border-radius: 20px;
  pointer-events: none;
  opacity: 0;
  background: linear-gradient(180deg, color-mix(in srgb, var(--nx-accent) 30%, transparent), color-mix(in srgb, var(--nx-accent) 14%, transparent));
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--nx-accent-2) 50%, transparent), 0 0 22px color-mix(in srgb, var(--nx-accent) 22%, transparent);
  transition: transform var(--rail-spring), opacity .12s ease;
  z-index: 0;
}

.theme-noir-light .mode-rail {
  background: color-mix(in srgb, var(--nx-surface) 60%, transparent);
  border-right-color: var(--nx-hair);
}

.theme-noir-light .active-indicator {
  background: var(--nx-indicator-bg);
  box-shadow: inset 0 0 0 1px var(--nx-indicator-edge), 0 6px 16px color-mix(in srgb, var(--nx-accent-2) 22%, transparent);
}

.theme-noir .active-indicator.visible {
  opacity: 1;
}

.theme-noir .active-indicator::before {
  content: '';
  position: absolute;
  left: -10px;
  top: 50%;
  width: 3px;
  height: 22px;
  margin-top: -11px;
  border-radius: 0 3px 3px 0;
  background: var(--nx-accent-2);
  box-shadow: 0 0 10px var(--nx-accent-2);
}

.theme-noir .mode-btn {
  width: 100%;
  height: 40px;
  min-height: 40px;
  margin: 0;
  padding: 0 12px;
  justify-content: flex-start;
  gap: 0;
  overflow: visible;
  border-radius: 20px;
  color: var(--nx-read-3);
  white-space: nowrap;
  user-select: none;
  transition: color .16s cubic-bezier(.22, 1, .36, 1), background .16s cubic-bezier(.22, 1, .36, 1), transform var(--rail-spring);
  z-index: 1;
}

.theme-noir .mode-btn:hover {
  color: var(--nx-read-2);
  background: color-mix(in srgb, var(--nx-accent) 10%, transparent);
}

.theme-noir .mode-btn:active {
  transform: scale(.92);
  transition-duration: .08s;
}

.theme-noir .mode-btn:focus-visible {
  outline: 2px solid var(--nx-accent-2);
  outline-offset: 2px;
}

.theme-noir .mode-btn.active {
  color: var(--nx-read-1);
  background: transparent;
}

.theme-noir .mode-btn.active::before {
  content: none;
}

.theme-noir .mode-btn:hover .icon {
  transform: none;
}

.theme-noir .mode-btn.active .icon {
  filter: drop-shadow(0 0 8px color-mix(in srgb, var(--nx-accent-2) 60%, transparent));
}

.theme-noir .recipe-app-btn.status-ok { color: var(--nx-success); }
.theme-noir .recipe-app-btn.status-warn { color: var(--nx-warning); }
.theme-noir .recipe-app-btn.status-bad { color: var(--nx-danger); }
.theme-noir .recipe-app-btn.status-bad .icon {
  animation: recipe-danger-pulse 2.4s ease-in-out infinite;
}

@keyframes recipe-danger-pulse {
  0%, 100% { filter: drop-shadow(0 0 3px color-mix(in srgb, var(--nx-danger) 35%, transparent)); }
  50% { filter: drop-shadow(0 0 10px color-mix(in srgb, var(--nx-danger) 75%, transparent)); }
}

.theme-noir .expanded .mode-btn {
  gap: 12px;
}

.theme-noir .rail-footer .mode-btn.active {
  background: color-mix(in srgb, var(--nx-accent) 14%, transparent);
}

.theme-noir .icon {
  width: 20px;
  height: 20px;
  flex: none;
}

.theme-noir .item-label {
  max-width: 0;
  display: inline;
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 500;
  opacity: 0;
  filter: blur(6px);
  transform: translateX(-6px);
  transition: opacity .24s cubic-bezier(.22, 1, .36, 1), filter .24s cubic-bezier(.22, 1, .36, 1), transform var(--rail-spring);
}

.theme-noir .expanded .item-label {
  max-width: 120px;
  opacity: 1;
  filter: blur(0);
  transform: none;
}

.theme-noir .shortcut-hint {
  margin-left: auto;
  color: var(--nx-read-5);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  opacity: 0;
  transition: opacity .2s ease;
}

.theme-noir .expanded .shortcut-hint {
  display: inline;
  opacity: 1;
}

.theme-noir .rail-divider {
  height: 1px;
  margin: 6px 8px;
  display: block;
  flex: none;
  background: var(--nx-hair);
}

.theme-noir .decision-badge {
  left: 25px;
  right: auto;
  top: 3px;
  min-width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--nx-accent);
  box-shadow: 0 0 8px var(--nx-accent), 0 0 0 2px var(--bg-surface-alt);
  font-weight: 650;
}

.theme-noir .decision-badge::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--nx-accent-2);
  animation: decision-ping 2.2s cubic-bezier(.22, 1, .36, 1) infinite;
  z-index: -1;
}

@keyframes decision-ping {
  0% { transform: scale(1); opacity: .6; }
  70%, 100% { transform: scale(2.2); opacity: 0; }
}

.theme-noir .mode-btn::after {
  content: attr(data-noir-tooltip);
  left: 52px;
  padding: 6px 10px;
  border-radius: 8px;
  color: var(--nx-read-1);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  transform: translate(-4px, -50%) scale(.96);
  transition: opacity .14s cubic-bezier(.22, 1, .36, 1), transform .3s var(--rail-spring);
}

.theme-noir .mode-rail:not(.expanded) .mode-btn:hover::after {
  transform: translate(0, -50%) scale(1);
  transition-delay: .25s;
}

.theme-noir .expanded .mode-btn::after {
  display: none;
}

.theme-noir .expand-toggle {
  display: flex;
}

.theme-noir .expand-icon {
  transition: transform var(--rail-spring);
}

.theme-noir .expanded .expand-icon {
  transform: scaleX(-1);
}

@media (prefers-reduced-motion: reduce) {
  .theme-noir .mode-rail,
  .theme-noir .active-indicator,
  .theme-noir .mode-btn,
  .theme-noir .item-label,
  .theme-noir .shortcut-hint,
  .theme-noir .expand-icon {
    transition: none;
  }

  .theme-noir .item-label {
    filter: none;
  }

  .theme-noir .decision-badge::after {
    animation: none;
  }
}
</style>

<style scoped>
.extension-menu{position:fixed;z-index:10000;min-width:190px;padding:6px;background:var(--surface-2,#121923);border:1px solid var(--border,rgba(168,192,220,.18));border-radius:9px;box-shadow:0 14px 38px rgba(0,0,0,.42)}.extension-menu small{display:block;padding:5px 9px;color:var(--text-muted,#8d9aab)}.extension-menu button{display:block;width:100%;border:0;background:transparent;color:var(--text,#eef3f8);text-align:left;padding:7px 9px;border-radius:6px}.extension-menu button:hover{background:var(--surface-3,rgba(255,255,255,.08))}.extension-menu .remove{color:var(--danger,#e27979)}
</style>
