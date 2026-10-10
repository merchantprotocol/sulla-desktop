<template>
  <aside
    v-if="cards.length"
    class="subagent-rail"
    aria-label="Sub-agents launched by this chat"
  >
    <div class="rail-heading">
      <span>Sub-agents</span>
      <span class="count">{{ runningCount }} running</span>
    </div>
    <div class="cards">
      <article
        v-for="card in cards"
        :key="`${card.jobId}:${card.taskIndex}`"
        class="agent-card"
        :class="[`is-${card.status}`, { clickable: card.conversationId }]"
        @click="openCard(card)"
      >
        <div class="card-top">
          <span
            class="status-dot"
            aria-hidden="true"
          />
          <span class="agent-id">{{ card.agentId }}</span>
          <button
            v-if="card.status !== 'running'"
            type="button"
            class="dismiss"
            title="Dismiss"
            aria-label="Dismiss sub-agent card"
            @click.stop="dismiss(card)"
          >
            ×
          </button>
        </div>
        <div class="label">
          {{ card.label }}
        </div>
        <div class="meta">
          <span>{{ card.status }}</span>
          <span>{{ elapsed(card) }}</span>
        </div>
        <p class="activity">
          {{ card.lastActivity }}
        </p>
      </article>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { ThreadAgentCard } from '@pkg/main/agentsIpc';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { SubAgentConversationTarget } from './subAgentConversation';

const props = defineProps<{ parentThreadId?: string }>();
const emit = defineEmits<{
  open:       [target: SubAgentConversationTarget];
  visibility: [visible: boolean];
}>();

const cards = ref<ThreadAgentCard[]>([]);
const now = ref(Date.now());
const runningCount = computed(() => cards.value.filter(card => card.status === 'running').length);
let timer: ReturnType<typeof setInterval> | null = null;
let request = 0;

async function refresh(): Promise<void> {
  const parentThreadId = props.parentThreadId;
  const current = ++request;
  now.value = Date.now();
  if (!parentThreadId) {
    cards.value = [];
    return;
  }
  try {
    const next = await ipcRenderer.invoke('agents:thread-jobs' as any, parentThreadId) as ThreadAgentCard[];
    if (current === request) cards.value = Array.isArray(next) ? next : [];
  } catch {
    if (current === request) cards.value = [];
  }
}

function openCard(card: ThreadAgentCard): void {
  if (!card.conversationId) return;
  emit('open', { agentId: card.agentId, label: card.label, conversationId: card.conversationId });
}

async function dismiss(card: ThreadAgentCard): Promise<void> {
  if (!props.parentThreadId) return;
  const ok = await ipcRenderer.invoke(
    'agents:dismiss-thread-job' as any,
    card.jobId,
    props.parentThreadId,
    card.taskIndex,
  );
  if (ok) cards.value = cards.value.filter(item => item !== card);
}

function elapsed(card: ThreadAgentCard): string {
  const end = card.finishedAt ?? now.value;
  const seconds = Math.max(0, Math.floor((end - card.createdAt) / 1000));
  if (seconds < 60) return `${ seconds }s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${ minutes }m ${ seconds % 60 }s`;
  const hours = Math.floor(minutes / 60);
  return `${ hours }h ${ minutes % 60 }m`;
}

watch(() => props.parentThreadId, refresh, { immediate: true });
watch(() => cards.value.length > 0, visible => emit('visibility', visible), { immediate: true });
onMounted(() => { timer = setInterval(refresh, 2_500) });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.subagent-rail {
  position: absolute;
  inset: 0 auto 0 0;
  z-index: 8;
  width: 272px;
  overflow: hidden;
  border-right: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-primary);
}
.rail-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-default);
  font: 600 12px var(--font-body, var(--sans));
}
.count { color: var(--text-muted); font: 10px var(--mono); }
.cards { height: calc(100% - 48px); overflow-y: auto; padding: 10px; }
.agent-card {
  margin-bottom: 8px;
  padding: 10px;
  border: 1px solid var(--border-default);
  border-radius: 9px;
  background: var(--bg-surface-alt);
  transition: border-color 0.15s ease, opacity 0.15s ease;
}
.agent-card.clickable { cursor: pointer; }
.agent-card.clickable:hover { border-color: var(--accent-primary); }
.card-top { display: flex; align-items: center; gap: 7px; min-width: 0; }
.status-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--text-muted); }
.is-running .status-dot { background: var(--accent-primary); animation: chat-pulse 1.4s ease-in-out infinite; }
.is-done .status-dot { background: var(--text-success); }
.is-failed .status-dot { background: var(--text-error); }
.is-stopped .status-dot { background: var(--text-warning); }
.agent-id { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 11px var(--mono); }
.dismiss { margin-left: auto; padding: 0 3px; color: var(--text-muted); font-size: 16px; line-height: 1; }
.dismiss:hover { color: var(--text-primary); }
.label { margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.meta { display: flex; gap: 8px; margin-top: 5px; color: var(--text-muted); font: 10px var(--mono); text-transform: uppercase; }
.activity {
  display: -webkit-box;
  margin: 7px 0 0;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.is-done, .is-failed, .is-stopped { opacity: 0.68; }
</style>
