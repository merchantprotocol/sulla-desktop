<!--
  Sulla's completed reply, rendered through a markdown pipeline that
  mirrors the existing BrowserTabChat (marked + DOMPurify).
-->
<template>
  <div class="chat-turn sulla chat-fade-in">
    <span class="chat-role">Sulla · {{ timeLabel }}</span>
    <div class="chat-body" v-html="rendered" />
    <TurnActions
      role="sulla"
      :pinned="msg.pinned"
      @copy="copy"
      @regenerate="$emit('regenerate')"
      @quote="$emit('quote')"
      @pin="$emit('pin')"
      @fork="$emit('fork')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import type { SullaMessage } from '../../models/Message';
import TurnActions from './TurnActions.vue';

const props = defineProps<{ msg: SullaMessage }>();
defineEmits<{
  (e: 'regenerate'): void; (e: 'quote'): void; (e: 'pin'): void; (e: 'fork'): void;
}>();

const timeLabel = computed(() => {
  const d = new Date(props.msg.createdAt);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
});

const rendered = computed(() => {
  const html = (marked(props.msg.text || '') as string) || '';
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
  });
});

function copy(): void {
  void navigator.clipboard?.writeText(props.msg.text);
}
</script>
