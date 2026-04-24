<!--
  The live voice-transcription bubble that grows as the user speaks.
  Disappears when recording stops (the controller creates a real
  UserMessage in its place).
-->
<template>
  <div class="chat-turn you interim chat-fade-in">
    <span class="chat-role">Listening…</span>
    <div class="chat-body">{{ msg.text }}</div>
  </div>
</template>

<script setup lang="ts">
import type { InterimMessage } from '../../models/Message';
defineProps<{ msg: InterimMessage }>();
</script>

<style scoped>
.chat-turn.interim { opacity: 0.8; }
.chat-turn.interim .chat-role { color: var(--steel-400); }
.chat-turn.interim .chat-role::before {
  content: ""; display: inline-block;
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--steel-400); box-shadow: 0 0 10px var(--steel-400);
  margin-right: 9px; vertical-align: 1px;
  animation: chat-pulse 1s infinite;
}
.chat-turn.interim .chat-body { color: var(--read-3); font-style: italic; }
.chat-turn.interim .chat-body::after {
  content: ""; display: inline-block;
  width: 10px; height: 19px;
  background: var(--steel-400); vertical-align: -3px; margin-left: 3px;
  box-shadow: 0 0 12px var(--steel-400);
  animation: chat-blink 0.9s step-end infinite;
}
</style>
