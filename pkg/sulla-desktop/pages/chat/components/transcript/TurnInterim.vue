<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
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
.chat-turn.interim .chat-role { color: var(--accent-hover); }
.chat-turn.interim .chat-role::before {
  content: ""; display: inline-block;
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent-hover); box-shadow: 0 0 10px var(--accent-hover);
  margin-right: 9px; vertical-align: 1px;
  animation: chat-pulse 1s infinite;
}
.chat-turn.interim .chat-body { color: var(--text-secondary); font-style: italic; }
.chat-turn.interim .chat-body::after {
  content: ""; display: inline-block;
  width: 10px; height: 19px;
  background: var(--accent-hover); vertical-align: -3px; margin-left: 3px;
  box-shadow: 0 0 12px var(--accent-hover);
  animation: chat-blink 0.9s step-end infinite;
}
</style>
