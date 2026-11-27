<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <time
    v-if="stamp"
    :datetime="stamp.iso"
    :title="stamp.full"
    :aria-label="stamp.full"
  >{{ stamp.label }}</time>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { LineTimes } from '../../messages/lineTime';

const props = defineProps<{
  row?:   { startedAt?: string | null; endedAt?: string | null; lastActivityAt?: string | null };
  at?:    string | number;
  event?: string;
}>();
const stamp = computed(() => {
  const times = props.row
    ? [
      ['Ended', props.row.endedAt], ['Latest activity', props.row.lastActivityAt], ['Started', props.row.startedAt],
    ] as const
    : [[props.event ?? 'Latest activity', props.at]] as const;
  for (const [event, value] of times) {
    const at = typeof value === 'number' ? value : Date.parse(value ?? '');
    if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(new Date(at).getTime())) continue;
    return { iso: new Date(at).toISOString(), label: LineTimes.shortTime(at), full: `${ event } · ${ LineTimes.fullTime(at) }` };
  }
  return undefined;
});
</script>
