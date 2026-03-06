<template>
  <div class="webview-tab">
    <iframe
      :src="content"
      class="webview-frame"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      referrerpolicy="no-referrer"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'WebViewTab',

  props: {
    content:  { type: String, default: '' },
    filePath: { type: String, default: '' },
    fileExt:  { type: String, default: '' },
    isDark:   { type: Boolean, default: false },
    readOnly: { type: Boolean, default: true },
  },

  setup() {
    return {};
  },
});
</script>

<style scoped>
.webview-tab {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.webview-frame {
  flex: 1;
  width: 100%;
  height: 100%;
  border: none;
}
</style>
