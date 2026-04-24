<!--
  Sulla reply in-flight. Identical styling to TurnSulla with a trailing
  cursor until streaming ends (controller flips kind to 'sulla').
-->
<template>
  <div class="chat-turn sulla chat-fade-in">
    <span class="chat-role">Sulla · responding</span>
    <div class="chat-body">
      <IsolatedHtml
        v-if="isHtmlDocument"
        :html="msg.text"
      />
      <span
        v-else
        v-html="rendered"
      />
      <span class="chat-cursor" aria-hidden="true" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import type { StreamingMessage } from '../../models/Message';
import IsolatedHtml from './IsolatedHtml.vue';

const props = defineProps<{ msg: StreamingMessage }>();

// Same detection as TurnSulla — bare <style>/<html>/<body> etc. routes
// through Shadow DOM so mid-stream CSS can't leak into the host app.
const HTML_DOC_RE = /<style\b|<script\b|<!doctype|<html\b|<body\b|<head\b/i;
const isHtmlDocument = computed(() => HTML_DOC_RE.test(props.msg.text || ''));

const rendered = computed(() => {
  const html = (marked(props.msg.text || '') as string) || '';
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
});
</script>
