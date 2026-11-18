<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';
import SecurityCard from './SecurityCard.vue';
import PrefRow from '../../PrefRow.vue';
import PrefToggle from '../../PrefToggle.vue';
import type { SecurityCheckResult } from './types';
const props = defineProps<{ hostAccess: boolean; locked: boolean; runtime: SecurityCheckResult | undefined; containers: SecurityCheckResult | undefined }>();
const emit = defineEmits<{ (event: 'update:hostAccess', value: boolean): void }>();
const warning = computed(() => props.hostAccess);
const hostLabel = computed(() => props.hostAccess ? 'Host access on' : 'Contained');
</script>
<template>
  <SecurityCard id="security-sandbox" title="Sandbox" subtitle="Where agent work actually runs." icon="box"  :status="hostLabel" :tone="warning ? 'warn' : 'good'">
    <PrefRow title="Agents run inside Sulla’s own virtual machine" :subtitle="runtime?.detail ?? 'A separate, isolated computer inside your Mac. Agent commands, installs and downloads stay in there.'" />
    <PrefRow title="Sub-agents get their own containers" :subtitle="containers?.detail ?? 'Each worker gets a fresh, isolated container that’s removed when the job ends.'" />
    <PrefRow title="Let agents run commands on this Mac" :subtitle="hostAccess ? 'On: agents can run commands directly on this Mac.' : 'Off keeps all agent work inside Sulla’s sandbox.'">
      <PrefToggle :model-value="hostAccess" :disabled="locked" label="Let agents run commands on this Mac" @update:model-value="emit('update:hostAccess', $event)" />
    </PrefRow>
  </SecurityCard>
</template>
