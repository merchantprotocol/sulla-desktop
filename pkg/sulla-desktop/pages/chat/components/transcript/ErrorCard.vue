<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <WorkBlock
    icon="!"
    tone="err"
    :by="msg.by"
  >
    <template #title>
      <b>{{ msg.text }}</b>
    </template>
    <template #meta>
      {{ msg.detail ? 'details' : '' }}
    </template>
    <pre
      v-if="msg.detail"
      class="ec-detail"
    >{{ msg.detail }}</pre>
    <p
      v-else
      class="ec-none"
    >
      No further detail was recorded.
    </p>
    <template #after>
      <div
        v-if="msg.action"
        class="ec-acts"
      >
        <button
          type="button"
          class="ec-btn"
          @click="$emit('action', msg.action.kind)"
        >
          {{ msg.action.label }}
        </button>
      </div>
    </template>
  </WorkBlock>
</template>

<script setup lang="ts">
import WorkBlock from './WorkBlock.vue';

import type { ErrorMessage } from '../../models/Message';
defineProps<{ msg: ErrorMessage }>();
defineEmits<(e: 'action', kind: 'retry' | 'continue' | 'dismiss' | 'connect') => void>();
</script>

<style scoped>
.ec-detail {
  max-height: 320px; overflow: auto; margin: 8px 0 0; padding: 8px 10px; border-radius: 7px; background: var(--wb-raised);
  color: var(--wb-ink-2); font: 12px/1.55 var(--font-mono, ui-monospace, monospace); white-space: pre-wrap; overflow-wrap: anywhere;
}
.ec-none { margin: 8px 0 0; color: var(--wb-ink-3); font-size: 12.5px; }
/* Retry / Connect stay visible: the error is often waiting on this click. */
.ec-acts { padding: 0 12px 10px 44px; }
.ec-btn {
  height: 30px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 8px; background: transparent;
  color: var(--text-primary); font-family: var(--font-body); font-size: 12.5px; cursor: pointer;
}
.ec-btn:hover { border-color: var(--accent); }
.ec-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
@media (max-width: 640px) { .ec-acts { padding-left: 12px; } }
</style>
