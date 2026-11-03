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
  background: var(--accent-glow);
  border-right: 1px solid var(--accent-dim);
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
  color: var(--accent);
  background: transparent;
  cursor: pointer;
  transition: color .2s ease, background .2s ease;
}

.mode-btn:hover {
  color: var(--text-primary);
  background: var(--accent-dim);
}

.mode-btn.active {
  color: var(--text-on-accent);
  background: var(--accent-dim);
}

.mode-btn.active::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 50%;
  width: 3px;
  height: 26px;
  border-radius: 0 3px 3px 0;
  background: var(--accent-hover);
  box-shadow: 0 0 10px var(--accent-hover);
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
  filter: drop-shadow(0 0 10px var(--accent-glow));
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
  color: var(--text-on-accent);
  background: var(--accent, var(--accent));
  box-shadow: 0 0 8px var(--accent, var(--accent));
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
  border: 1px solid var(--accent-dim);
  border-radius: 5px;
  color: var(--text-primary, var(--text-primary));
  background: var(--accent);
  box-shadow: 0 6px 22px var(--bg-page);
  font-family: var(--font-mono);
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

.mode-rail {
  box-sizing: border-box;
  width: 64px;
  padding: 40px 10px 10px;
  overflow: visible;
  color: var(--text-muted);
  transition: width var(--dur-move) var(--spring);
  z-index: 20;
}

.mode-rail.expanded {
  width: 212px;
}

.rail-items,
.rail-footer {
  position: relative;
}

.active-indicator {
  position: absolute;
  inset: 0 0 auto;
  display: block;
  border-radius: 20px;
  pointer-events: none;
  opacity: 0;
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 30%, transparent), color-mix(in srgb, var(--accent) 14%, transparent));
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--accent-hover) 50%, transparent), 0 0 22px color-mix(in srgb, var(--accent) 22%, transparent);
  transition: transform var(--dur-move) var(--spring), opacity .12s ease;
  z-index: 0;
}

.mode-rail {
  background: color-mix(in srgb, var(--bg-surface) 60%, transparent);
  border-right-color: var(--border-subtle);
}

.active-indicator {
  background: var(--accent-dim);
  box-shadow: inset 0 0 0 1px var(--accent-border), 0 6px 16px color-mix(in srgb, var(--accent-hover) 22%, transparent);
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
  background: var(--accent-hover);
  box-shadow: 0 0 10px var(--accent-hover);
}

.mode-btn {
  width: 100%;
  height: 40px;
  min-height: 40px;
  margin: 0;
  padding: 0 12px;
  justify-content: flex-start;
  gap: 0;
  overflow: visible;
  border-radius: 20px;
  color: var(--text-muted);
  white-space: nowrap;
  user-select: none;
  transition: color .16s cubic-bezier(.22, 1, .36, 1), background .16s cubic-bezier(.22, 1, .36, 1), transform var(--dur-move) var(--spring);
  z-index: 1;
}

.mode-btn:hover {
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.mode-btn:active {
  transform: scale(.92);
  transition-duration: .08s;
}

.mode-btn:focus-visible {
  outline: 2px solid var(--accent-hover);
  outline-offset: 2px;
}

.mode-btn.active {
  color: var(--text-primary);
  background: transparent;
}

.mode-btn.active::before {
  content: none;
}

.mode-btn:hover .icon {
  transform: none;
}

.mode-btn.active .icon {
  filter: drop-shadow(0 0 8px color-mix(in srgb, var(--accent-hover) 60%, transparent));
}

.recipe-app-btn.status-ok { color: var(--status-success); }
.recipe-app-btn.status-warn { color: var(--status-warning); }
.recipe-app-btn.status-bad { color: var(--status-error); }
.recipe-app-btn.status-bad .icon {
  animation: recipe-danger-pulse 2.4s ease-in-out infinite;
}

@keyframes recipe-danger-pulse {
  0%, 100% { filter: drop-shadow(0 0 3px color-mix(in srgb, var(--status-error) 35%, transparent)); }
  50% { filter: drop-shadow(0 0 10px color-mix(in srgb, var(--status-error) 75%, transparent)); }
}

.expanded .mode-btn {
  gap: 12px;
}

.rail-footer .mode-btn.active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.icon {
  width: 20px;
  height: 20px;
  flex: none;
}

.item-label {
  max-width: 0;
  display: inline;
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 500;
  opacity: 0;
  filter: blur(6px);
  transform: translateX(-6px);
  transition: opacity .24s cubic-bezier(.22, 1, .36, 1), filter .24s cubic-bezier(.22, 1, .36, 1), transform var(--dur-move) var(--spring);
}

.expanded .item-label {
  max-width: 120px;
  opacity: 1;
  filter: blur(0);
  transform: none;
}

.shortcut-hint {
  margin-left: auto;
  color: var(--text-dim);
  font-family: var(--font-mono);
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
  display: block;
  flex: none;
  background: var(--border-subtle);
}

.decision-badge {
  left: 25px;
  right: auto;
  top: 3px;
  min-width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent), 0 0 0 2px var(--bg-surface-alt);
  font-weight: 650;
}

.decision-badge::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--accent-hover);
  animation: decision-ping 2.2s cubic-bezier(.22, 1, .36, 1) infinite;
  z-index: -1;
}

@keyframes decision-ping {
  0% { transform: scale(1); opacity: .6; }
  70%, 100% { transform: scale(2.2); opacity: 0; }
}

.mode-btn::after {
  content: attr(data-noir-tooltip);
  left: 52px;
  padding: 6px 10px;
  border-radius: 8px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  transform: translate(-4px, -50%) scale(.96);
  transition: opacity .14s cubic-bezier(.22, 1, .36, 1), transform .3s var(--dur-move) var(--spring);
}

.mode-rail:not(.expanded) .mode-btn:hover::after {
  transform: translate(0, -50%) scale(1);
  transition-delay: .25s;
}

.expanded .mode-btn::after {
  display: none;
}

.expand-toggle {
  display: flex;
}

.expand-icon {
  transition: transform var(--dur-move) var(--spring);
}

.expanded .expand-icon {
  transform: scaleX(-1);
}

@media (prefers-reduced-motion: reduce) {
  .mode-rail,
  .active-indicator,
  .mode-btn,
  .item-label,
  .shortcut-hint,
  .expand-icon {
    transition: none;
  }

  .item-label {
    filter: none;
  }

  .decision-badge::after {
    animation: none;
  }
}
</style>

<style scoped>
.extension-menu{position:fixed;z-index:10000;min-width:190px;padding:6px;background:var(--surface-2,var(--accent));border:1px solid var(--border,var(--accent-dim));border-radius:9px;box-shadow:0 14px 38px var(--bg-overlay)}.extension-menu small{display:block;padding:5px 9px;color:var(--text-muted,var(--accent))}.extension-menu button{display:block;width:100%;border:0;background:transparent;color:var(--text,var(--text-primary));text-align:left;padding:7px 9px;border-radius:6px}.extension-menu button:hover{background:var(--surface-3,var(--bg-hover))}.extension-menu .remove{color:var(--status-error,var(--status-error))}
</style>
