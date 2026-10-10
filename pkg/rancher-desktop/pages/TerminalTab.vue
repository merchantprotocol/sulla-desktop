<template>
  <div class="terminal-tab">
    <div
      class="terminal-chrome"
      aria-hidden="true"
    >
      <span class="terminal-status-dot" />
      <span class="terminal-title">Terminal</span>
      <span class="terminal-session">Lima VM · {{ sessionId }}</span>
    </div>
    <XTermTerminal
      :session-id="sessionId"
      :is-dark="true"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';

import XTermTerminal from '@pkg/pages/editor/XTermTerminal.vue';

export default defineComponent({
  name: 'TerminalTab',

  components: { XTermTerminal },

  props: {
    /** The browser-tab id — used to keep a stable PTY session per tab. */
    tabId: {
      type:    String,
      default: '',
    },
  },

  setup(props) {
    // Stable session id so switching away and back reattaches to the same
    // Lima VM shell instead of spawning a fresh one.
    const sessionId = computed(() => `tab-${ props.tabId || 'default' }`);

    return { sessionId };
  },
});
</script>

<style scoped>
.terminal-tab {
  width:            100%;
  height:           100%;
  overflow:         hidden;
  background-color: var(--bg-surface, #1e293b);
  padding:          6px 8px;
}

.terminal-chrome {
  display: none;
}
</style>

<style scoped>
.theme-noir .terminal-tab {
  display: flex;
  flex-direction: column;
  padding: 0;
  background: var(--nx-paper);
}

.theme-noir .terminal-chrome {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 14px;
  flex: none;
  color: var(--nx-read-3);
  background: color-mix(in srgb, var(--bg-surface-alt) 76%, transparent);
  border-bottom: 1px solid var(--nx-hair);
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 11px;
  backdrop-filter: blur(18px);
}

.theme-noir .terminal-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--nx-success);
  box-shadow: 0 0 8px color-mix(in srgb, var(--nx-success) 70%, transparent);
}

.theme-noir .terminal-title { color: var(--nx-read-1); font-weight: 600; }
.theme-noir .terminal-session { margin-left: auto; color: var(--nx-read-4); }
.theme-noir .terminal-tab > :deep(.terminal-wrapper) {
  min-height: 0;
  padding: 9px 10px 7px;
  background: var(--bg-surface-alt);
}
</style>
