<template>
  <div class="terminal-tab">
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
</style>
