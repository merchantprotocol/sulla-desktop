<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <IsolatedHtml v-if="reply.isolated" :html="reply.html" />
  <div v-else v-html="rendered" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import IsolatedHtml from './IsolatedHtml.vue';
import { A2aCardMarkup } from '../../messages/a2aCardMarkup';
import { InlineReplyMarkup } from '../../messages/InlineReplyMarkup';
import { sanitizeMarkdownHtml } from '../../messages/markdown';

const props = defineProps<{ text: string; legacyHtml?: boolean; agentMessagesAsTrace?: boolean }>();
const formatter = new InlineReplyMarkup();
const cards = new A2aCardMarkup();
const reply = computed(() => formatter.render(props.agentMessagesAsTrace ? cards.strip(props.text) : props.text, props.legacyHtml));
const rendered = computed(() => sanitizeMarkdownHtml(reply.value.html));
</script>
