<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <span
    class="wf-loc"
    :class="{ server: location === 'server' }"
  >
    <WfIcon :name="location === 'server' ? 'server' : 'desktop'" />{{ location === 'server' ? 'Server' : (deviceName || 'This device') }}
  </span>
</template>

<script setup lang="ts">
import WfIcon from '@pkg/components/routines/WfIcon.vue';

defineProps<{
  location:   'desktop' | 'server';
  deviceName: string;
}>();
</script>

<style scoped lang="scss">
.wf-loc {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 11.5px;
  white-space: nowrap;

  svg { width: 13px; height: 13px; flex: none; }
  &.server {
    border-color: var(--border-accent);
    background: var(--bg-accent);
    color: var(--text-accent);
  }
}
</style>
