<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Shown under the user's message while Sulla is running but has sent
  nothing back yet, so a sent message never looks like it vanished.
  After NO_RESPONSE_AFTER_MS it says so and offers Stop / Stop and resend.
-->
<template>
  <div
    class="chat-turn sulla waiting"
    :class="{ stalled: label.stalled }"
    role="status"
    aria-live="polite"
  >
    <span class="chat-role">{{ label.text }}</span>
    <div
      v-if="label.stalled"
      class="waiting-actions"
    >
      <button
        type="button"
        class="waiting-btn"
        @click="$emit('stop')"
      >
        Stop
      </button>
      <button
        v-if="canResend"
        type="button"
        class="waiting-btn primary"
        @click="$emit('resend')"
      >
        Stop and resend
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

import { waitingLabel } from '../../messages/waitingStatus';

const props = defineProps<{ since: number; canResend: boolean }>();
defineEmits<{ (e: 'stop'): void; (e: 'resend'): void }>();

const now = ref(Date.now());
const timer = setInterval(() => { now.value = Date.now() }, 1000);
onBeforeUnmount(() => clearInterval(timer));

const label = computed(() => waitingLabel(now.value - props.since));
</script>

<style scoped>
.chat-turn.waiting .chat-role { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.chat-turn.waiting .chat-role::before {
  content: ""; display: inline-block;
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent-hover); box-shadow: 0 0 10px var(--accent-hover);
  margin-right: 9px; vertical-align: 1px;
  animation: chat-pulse 1s infinite;
}
.chat-turn.waiting.stalled .chat-role { color: var(--status-warning); }
.chat-turn.waiting.stalled .chat-role::before {
  background: var(--status-warning); box-shadow: none; animation: none;
}
.waiting-actions { display: flex; gap: 8px; margin-top: 10px; }
.waiting-btn {
  font: inherit; font-size: 13px;
  padding: 6px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--border-strong, var(--text-secondary));
  background: transparent; color: var(--text-primary);
}
.waiting-btn.primary { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--bg-primary, #0b1320); }
.waiting-btn:focus-visible { outline: 2px solid var(--accent-hover); outline-offset: 2px; }
</style>
