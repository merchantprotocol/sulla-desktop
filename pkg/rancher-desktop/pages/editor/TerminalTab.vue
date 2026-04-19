<template>
  <div class="terminal-tab-wrapper">
    <XTermTerminal
      :is-dark="isDark"
      :command="content"
      :read-only="readOnly"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

import XTermTerminal from './XTermTerminal.vue';

export default defineComponent({
  name: 'TerminalTab',

  components: { XTermTerminal },

  props: {
    content:  { type: String, default: '' },
    filePath: { type: String, default: '' },
    fileExt:  { type: String, default: '' },
    isDark:   { type: Boolean, default: false },
    readOnly: { type: Boolean, default: false },
  },

  setup() {
    return {};
  },
});
</script>

<style scoped>
.terminal-tab-wrapper {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
