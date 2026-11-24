<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <InlineFileCard :file="file">
    <template #preview="{ file: previewFile }">
      <p class="synthetic-slot-preview">{{ previewFile.name }}</p>
    </template>
  </InlineFileCard>
</template>

<script setup lang="ts">
import InlineFileCard from '../../../../../pages/chat/components/files/InlineFileCard.vue';
import type { InlineFileCardViewModel } from '../../../../../pages/chat/components/files/inlineFilePreview';

defineProps<{ file: InlineFileCardViewModel }>();
</script>
