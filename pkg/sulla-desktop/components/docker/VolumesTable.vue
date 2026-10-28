<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->

<template>
  <section class="docker-section" :aria-label="label">
    <slot />
  </section>
</template>

<script setup lang="ts">
defineProps<{ label?: string }>();
</script>
