<!--
  HTML artifact — sandboxed iframe. Never injects arbitrary HTML into
  the main DOM (CSP + sanitization happens before payload is set).
-->
<template>
  <div class="html-widget">
    <iframe
      ref="iframeEl"
      sandbox="allow-scripts allow-same-origin"
      :srcdoc="payload.html"
      loading="lazy"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { HtmlPayload } from '../../../models/Artifact';

defineProps<{ payload: HtmlPayload }>();
const iframeEl = ref<HTMLIFrameElement | null>(null);
</script>

<style scoped>
.html-widget {
  width: 100%; height: 100%;
  background: rgba(20, 30, 42, 0.5);
  border: 1px solid rgba(168, 192, 220, 0.12);
  border-radius: 8px;
}
iframe {
  width: 100%; height: 100%;
  border: none; border-radius: 8px;
  background: transparent;
}
</style>
