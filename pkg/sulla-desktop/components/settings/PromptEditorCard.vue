<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import PrefCard from './PrefCard.vue';

import type { PromptSection } from '@pkg/composables/preferences/usePromptSections';

const props = defineProps<{
  title:     string;
  subtitle?: string;
  section:   PromptSection | undefined;
  rows?:     number;
}>();
const emit = defineEmits<{
  (e: 'save', content: string): void;
  (e: 'reset'): void;
}>();

const draft = ref('');

watch(() => props.section?.content, (content) => {
  draft.value = content ?? '';
}, { immediate: true });

const dirty = computed(() => !!props.section && draft.value !== props.section.content);
</script>

<template>
  <PrefCard
    :title="title"
    :subtitle="subtitle"
  >
    <template #actions>
      <slot name="actions" />
      <button
        v-if="dirty"
        type="button"
        class="btn sm ghost"
        @click="draft = section?.content ?? ''"
      >
        Undo
      </button>
      <button
        v-if="dirty"
        type="button"
        class="btn sm pri"
        @click="emit('save', draft)"
      >
        Save
      </button>
      <button
        v-else-if="section?.is_builtin"
        type="button"
        class="btn sm ghost"
        :disabled="!section.is_customized"
        @click="emit('reset')"
      >
        Reset to default
      </button>
    </template>
    <div class="set col">
      <textarea
        v-model="draft"
        class="ta"
        :rows="rows ?? 9"
        :disabled="!section"
        :aria-label="title"
        :placeholder="section ? '' : 'Loading…'"
      />
    </div>
  </PrefCard>
</template>
