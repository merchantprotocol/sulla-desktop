<!--
  ModeRail — vertical icon bar on the far left that lets the user
  switch the containing tab between modes (chat, browser, routines,
  secretary, library, marketplace). Emits `set-mode` up to ChatPage,
  which bubbles to BrowserTab via its existing set-mode listener.

  The "chat" icon is highlighted as active because we're inside ChatPage.
-->
<template>
  <nav class="mode-rail" aria-label="Mode switcher">
    <button
      v-for="(item, idx) in items"
      :key="`${ item.mode }:${ item.subTab ?? '' }`"
      type="button"
      :class="['mode-btn', { active: isActive(item, idx) }]"
      :data-tooltip="item.label"
      :aria-label="item.label"
      @click="$emit('set-mode', item.mode, item.subTab)"
    >
      <span class="icon" v-html="item.icon" />
    </button>
  </nav>
</template>

<script setup lang="ts">
const props = defineProps<{
  /** Currently active mode — we'll highlight it. */
  active?:       string;
  /** When `active === 'routines'`, disambiguates My Work vs Library. */
  activeSubTab?: string;
}>();

defineEmits<{
  (e: 'set-mode', mode: string, subTab?: string): void;
}>();

interface ModeItem {
  mode:   string;
  label:  string;
  icon:   string;   // inline SVG string
  subTab?: string;
}

/**
 * Highlight the item whose mode + subTab both match. Multiple items can
 * share the same `mode` (My Work + Library both map to 'routines'); we
 * use `activeSubTab` to pick between them. Falls back to the first match
 * on the mode when no subTab is set.
 */
function isActive(item: ModeItem, idx: number): boolean {
  if (item.mode !== props.active) return false;
  if (item.subTab && props.activeSubTab) {
    return item.subTab === props.activeSubTab;
  }
  const firstIdx = items.findIndex(x => x.mode === props.active);
  return firstIdx === idx;
}

const items: readonly ModeItem[] = Object.freeze([
  {
    mode:  'chat',
    label: 'Chat',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>`,
  },
  {
    mode:  'browser',
    label: 'Browser',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>`,
  },
  {
    mode:    'routines',
    subTab:  'mywork',
    label:   'My Work',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
    </svg>`,
  },
  {
    mode:  'secretary',
    label: 'Secretary',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2v4"/>
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 1 0 6 0V5a3 3 0 0 0-3-3z"/>
      <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
      <line x1="12" y1="18" x2="12" y2="22"/>
      <line x1="8"  y1="22" x2="16" y2="22"/>
    </svg>`,
  },
  {
    mode:    'routines',
    subTab:  'library',
    label:   'Library',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
    </svg>`,
  },
  {
    mode:  'marketplace',
    label: 'Marketplace',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 7l1-4h16l1 4"/>
      <path d="M3 7v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7"/>
      <path d="M3 7h18"/>
      <path d="M8 11a4 4 0 0 0 8 0"/>
    </svg>`,
  },
  {
    mode:  'vault',
    label: 'Password Vault',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>`,
  },
]);
</script>

<style scoped>
.mode-rail {
  width: 52px; height: 100%;
  display: flex; flex-direction: column; align-items: stretch;
  /* Top padding reserves space for the macOS traffic-light buttons so
     icons don't hide behind them. */
  padding: 40px 0 10px;
  background: rgba(3, 6, 12, 0.55);
  border-right: 1px solid rgba(168, 192, 220, 0.08);
  backdrop-filter: blur(10px);
  flex-shrink: 0;
  gap: 4px;
  overflow-y: auto; overflow-x: visible;
  scrollbar-width: none;
}
.mode-rail::-webkit-scrollbar { display: none; }

.mode-btn {
  position: relative;
  background: transparent; border: none; cursor: pointer;
  padding: 8px 0;
  color: #a9b3c1;
  display: flex;
  align-items: center; justify-content: center;
  transition: color 0.2s ease, background 0.2s ease;
  margin: 0 6px;
  border-radius: 8px;
}
.mode-btn:hover {
  color: #dee4ec;
  background: rgba(80, 150, 179, 0.12);
}
.mode-btn .icon {
  display: flex; align-items: center; justify-content: center;
  width: 34px; height: 34px;
  transition: filter 0.2s ease, transform 0.15s ease;
}
.mode-btn:hover .icon { transform: translateY(-1px); }

.mode-btn.active {
  color: white;
  background: rgba(80, 150, 179, 0.14);
}
.mode-btn.active::before {
  content: "";
  position: absolute;
  left: -6px; top: 50%;
  transform: translateY(-50%);
  width: 3px; height: 26px; border-radius: 0 3px 3px 0;
  background: var(--steel-400);
  box-shadow: 0 0 10px var(--steel-400);
}
.mode-btn.active .icon {
  filter: drop-shadow(0 0 10px rgba(106, 176, 204, 0.45));
}

/* Tooltip — sticks out to the right on hover */
.mode-btn::after {
  content: attr(data-tooltip);
  position: absolute;
  left: calc(100% + 10px);
  top: 50%;
  transform: translateY(-50%) translateX(-4px);
  padding: 5px 10px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--read-1, #e6edf3);
  background: rgba(12, 18, 28, 0.96);
  border: 1px solid rgba(168, 192, 220, 0.18);
  border-radius: 5px;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.12s ease, transform 0.12s ease;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.55);
  z-index: 1000;
}
.mode-btn:hover::after {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}
</style>
