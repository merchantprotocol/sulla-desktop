<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import { CONV_ICONS } from '../convIcons';

defineProps<{ name: string }>();
</script>

<template>
  <span class="cv-icon" v-html="CONV_ICONS[name] ?? ''" />
</template>

<style>
.cv-icon { display: contents; }
</style>
