<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';
import PrefCard from '../../PrefCard.vue';
import PrefRow from '../../PrefRow.vue';
import PrefToggle from '../../PrefToggle.vue';
import type { SecurityCheckResult } from './types';
const props = defineProps<{ hostAccess: boolean; locked: boolean; runtime: SecurityCheckResult | undefined; containers: SecurityCheckResult | undefined }>();
const emit = defineEmits<{ (event: 'update:hostAccess', value: boolean): void }>();
const warning = computed(() => props.hostAccess);
</script>
<template>
  <PrefCard id="security-sandbox" title="Sandbox" subtitle="Where agent work actually runs." :class="{ warning }">
    <PrefRow v-if="runtime" title="Agent runtime" :subtitle="runtime.detail" />
    <PrefRow v-if="containers" title="Sub-agent containers" :subtitle="containers.detail" />
    <PrefRow title="Let agents run commands on this Mac" :subtitle="hostAccess ? 'On: agents can run commands directly on this Mac.' : 'Off keeps all agent work inside Sulla’s sandbox.'">
      <PrefToggle :model-value="hostAccess" :disabled="locked" label="Let agents run commands on this Mac" @update:model-value="emit('update:hostAccess', $event)" />
    </PrefRow>
  </PrefCard>
</template>
<style scoped>.warning { border-color: var(--border-warning); background: var(--bg-warning); }</style>
