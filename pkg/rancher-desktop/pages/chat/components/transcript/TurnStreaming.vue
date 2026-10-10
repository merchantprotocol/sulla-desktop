<!--
  Sulla reply in-flight. Identical styling to TurnSulla with a trailing
  cursor until streaming ends (controller flips kind to 'sulla').
-->
<template>
  <div class="chat-turn sulla chat-fade-in">
    <span class="chat-role">Sulla · {{ timeLabel }} · responding</span>
    <div class="chat-body">
      <IsolatedHtml
        v-if="isHtmlDocument"
        :html="htmlDocument"
      />
      <span
        v-else
        v-html="rendered"
      />
      <span
        class="chat-cursor"
        aria-hidden="true"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import IsolatedHtml from './IsolatedHtml.vue';
import { renderMarkdown } from '../../messages/markdown';

import type { StreamingMessage } from '../../models/Message';

const props = defineProps<{ msg: StreamingMessage }>();

const timeLabel = computed(() => {
  const d = new Date(props.msg.createdAt);
  return `${ d.getHours() % 12 || 12 }:${ String(d.getMinutes()).padStart(2, '0') }`;
});

// Same detection as TurnSulla — bare <style>/<html>/<body> etc. routes
// through Shadow DOM so mid-stream CSS can't leak into the host app.
const HTML_DOC_RE = /<style\b|<script\b|<!doctype|<html\b|<body\b|<head\b/i;
const isHtmlDocument = computed(() => HTML_DOC_RE.test(props.msg.text || ''));

// Once the <html>…</html> block is closed, freeze on it. Tokens streamed
// after it (wrapper, citations) would otherwise repaint the whole shadow
// tree on every token and reset any interactive widget the user touches.
const COMPLETE_HTML_RE = /<html\b[^>]*>[\s\S]*?<\/html>/i;
const htmlDocument = computed(() => {
  const text = props.msg.text || '';

  return COMPLETE_HTML_RE.exec(text)?.[0] ?? text;
});

const rendered = computed(() => renderMarkdown(props.msg.text));
</script>
