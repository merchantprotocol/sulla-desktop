<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ text: string }>();

// Message text is user content: it renders as text nodes, never as HTML. @mentions get the highlight class.
const parts = computed(() => props.text.split(/(@[\p{L}][\p{L}\p{N}_-]*)/u).map((value, index) => ({ value, mention: index % 2 === 1 })));
</script>

<template>
  <span><template v-for="(part, index) in parts" :key="index"><span v-if="part.mention" class="mention">{{ part.value }}</span><template v-else>{{ part.value }}</template></template></span>
</template>
