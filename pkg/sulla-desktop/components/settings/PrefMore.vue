<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->

<script setup lang="ts">
import { ref } from 'vue';

import PrefIcon from './PrefIcon.vue';

const props = defineProps<{ label: string; open?: boolean }>();
const isOpen = ref(!!props.open);
</script>

<template>
  <button
    type="button"
    class="more"
    :class="{ open: isOpen }"
    :aria-expanded="isOpen"
    @click="isOpen = !isOpen"
  >
    <PrefIcon name="chev" />{{ label }}
  </button>
  <div
    v-if="isOpen"
    class="adv"
  >
    <slot />
  </div>
</template>
