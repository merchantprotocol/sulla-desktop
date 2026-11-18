<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import ConvIcon from './ConvIcon.vue';

withDefaults(defineProps<{
  ini?: string;
  color?: string;
  pres?: string;
  size?: '' | 'sm' | 'lg';
  bot?: boolean;
  theirs?: boolean;
  gradient?: string;
}>(), { ini: '', color: '', pres: '', size: '', bot: false, theirs: false, gradient: '' });
</script>

<template>
  <span v-if="bot" class="avatar bot" :class="[theirs ? 'theirs' : '', size]" :style="gradient ? { background: gradient } : undefined">
    <ConvIcon name="robot" />
    <span v-if="pres" class="pres" :class="pres" />
  </span>
  <span v-else class="avatar" :class="[color, size]" :style="gradient ? { background: gradient } : undefined">
    {{ ini }}
    <span v-if="pres" class="pres" :class="pres" />
  </span>
</template>
