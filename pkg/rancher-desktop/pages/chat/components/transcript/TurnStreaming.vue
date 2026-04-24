<!--
  Sulla reply in-flight. Identical styling to TurnSulla with a trailing
  cursor until streaming ends (controller flips kind to 'sulla').
-->
<template>
  <div class="chat-turn sulla chat-fade-in">
    <span class="chat-role">Sulla · responding</span>
    <div class="chat-body">
      <span v-html="rendered" />
      <span class="chat-cursor" aria-hidden="true" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import type { StreamingMessage } from '../../models/Message';

const props = defineProps<{ msg: StreamingMessage }>();

const rendered = computed(() => {
  const html = (marked(props.msg.text || '') as string) || '';
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
});
</script>
