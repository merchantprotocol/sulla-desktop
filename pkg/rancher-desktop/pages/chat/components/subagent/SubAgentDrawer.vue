<template>
  <div
    v-if="target"
    class="drawer-backdrop"
    @click.self="$emit('close')"
  >
    <aside
      class="drawer"
      aria-label="Sub-agent conversation"
    >
      <AgentConversations
        :channel="target.agentId"
        :agent-name="target.label"
        :conversation-id="target.conversationId"
        :tick="tick"
        @close="$emit('close')"
      />
    </aside>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import AgentConversations from '@pkg/pages/agents/AgentConversations.vue';

import type { SubAgentConversationTarget } from './subAgentConversation';

defineProps<{ target: SubAgentConversationTarget | null }>();
defineEmits<{ close: [] }>();

const tick = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { timer = setInterval(() => { tick.value++ }, 2_500) });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.drawer-backdrop { position: absolute; inset: 0; z-index: 40; background: color-mix(in srgb, var(--bg-page) 35%, transparent); }
.drawer {
  position: absolute;
  inset: 0 0 0 auto;
  width: min(760px, 78vw);
  border-left: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: -16px 0 40px color-mix(in srgb, var(--text-primary) 12%, transparent);
}
.drawer :deep(.conv-toolbar), .drawer :deep(.conv-list) { border-color: var(--border-default); }
.drawer :deep(.conv-back) { color: var(--accent-primary); }
.drawer :deep(.conv-back:hover), .drawer :deep(.conv-item-active) { background: var(--bg-surface-hover); }
@media (max-width: 760px) { .drawer { width: 100%; } }
</style>
