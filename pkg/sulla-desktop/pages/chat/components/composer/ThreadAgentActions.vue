<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- An agent row's actions in the thread activity tray: nudge or message, open, stop (click twice). -->
<template>
  <span class="ta-acts">
    <!-- Icon-sized like its siblings: a text button overflowed the fixed actions column. -->
    <button
      v-if="row.canMessage && stalled"
      type="button"
      class="ta-btn ta-icon"
      title="Nudge: ask for a status update"
      :aria-label="`Nudge ${row.label}`"
      :disabled="busy"
      @click.stop="emit('nudge')"
    ><svg
      viewBox="0 0 16 16"
      aria-hidden="true"
    ><path d="M8 2.5a3.5 3.5 0 0 0-3.5 3.5v2.2L3 10.5h10l-1.5-2.3V6A3.5 3.5 0 0 0 8 2.5zM6.5 12.5a1.5 1.5 0 0 0 3 0" /></svg></button>
    <button
      v-else-if="row.canMessage"
      type="button"
      class="ta-btn ta-icon"
      title="Message"
      :aria-label="`Message ${row.label}`"
      @click.stop="emit('message')"
    ><svg
      viewBox="0 0 16 16"
      aria-hidden="true"
    ><path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" /></svg></button>
    <button
      v-if="row.canOpen && row.threadId"
      type="button"
      class="ta-btn ta-icon"
      title="Open"
      :aria-label="`Open ${row.label}`"
      @click.stop="emit('open')"
    ><svg
      viewBox="0 0 16 16"
      aria-hidden="true"
    ><path d="M6.5 3.5h-3v9h9v-3M9 3.5h3.5V7M12.5 3.5 7 9" /></svg></button>
    <button
      v-if="row.canStop"
      type="button"
      class="ta-btn ta-icon ta-danger"
      :title="confirming ? 'Click again to stop' : 'Stop'"
      :aria-label="confirming ? `Confirm stop ${row.label}` : `Stop ${row.label}`"
      :class="{ 'ta-confirm': confirming }"
      @click.stop="emit('stop')"
    ><template v-if="confirming">Stop?</template><svg
      v-else
      viewBox="0 0 16 16"
      aria-hidden="true"
    ><rect
      x="4.5"
      y="4.5"
      width="7"
      height="7"
      rx="1.2"
      class="ta-fill"
    /></svg></button>
  </span>
</template>

<script setup lang="ts">
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

defineProps<{ row: AgentStateRow; stalled: boolean; busy: boolean; confirming: boolean }>();
const emit = defineEmits<{ (e: 'nudge'): void; (e: 'message'): void; (e: 'open'): void; (e: 'stop'): void }>();
</script>

<style scoped src="../../styles/thread-status-line.css"></style>
