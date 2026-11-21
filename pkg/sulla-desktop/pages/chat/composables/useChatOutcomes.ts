// SPDX-License-Identifier: GPL-2.0-or-later
import { computed, inject, ref, shallowRef, watch, type Ref } from 'vue';

import { useChatController } from '../controller/useChatController';
import { ThreadGoalProgress } from '../messages/ThreadGoalProgress';

import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import type { SavedOutcomeReport } from '@pkg/shared/agentResults/AgentResultCard';
import type { ChatOutcomeArchive } from '@pkg/shared/productOwnerWorkflow';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export class ChatOutcomesLoader {
  private wait(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

  async load(
    threadId: string,
    conversationId: string,
    isCurrent: () => boolean,
  ): Promise<ChatOutcomeArchive | undefined> {
    for (const delay of [0, 1_500, 5_000]) {
      if (delay) await this.wait(delay);
      if (!isCurrent()) return undefined;
      try {
        const archive = await ipcRenderer.invoke('chat-workflow:outcomes', threadId, conversationId);
        if (!Array.isArray(archive?.reports) || !Array.isArray(archive.history)) throw new Error('Reports are unavailable.');
        return archive;
      } catch {
        // Short database or VM stalls are common enough to retry locally.
      }
    }
    return undefined;
  }
}

export function useChatOutcomes(threadId: Ref<string | undefined>) {
  const controller = useChatController();
  const client = inject(AGENT_STATE_CLIENT_KEY, null);
  const conversationId = computed(() => controller.thread.value?.id);
  const rows = computed(() => client?.snapshot.value.rows.filter(row => row.rootThreadId === threadId.value) ?? []);
  const settled = computed(() => rows.value.filter(row => row.endedAt || ['done', 'failed', 'stopped'].includes(row.state))
    .map(row => `${ row.key }=${ row.state }`).sort().join('|'));
  const stored = shallowRef<ChatOutcomeArchive>();
  const error = ref(false);
  const loading = ref(false);
  const retry = ref(0);
  const loader = new ChatOutcomesLoader();
  let loadSequence = 0;

  watch([threadId, conversationId], () => {
    loadSequence++;
    stored.value = undefined;
    error.value = false;
    loading.value = false;
  }, { flush: 'sync' });
  watch([threadId, conversationId, settled, retry], ([thread, chat], _, onCleanup) => {
    if (!thread || !chat) return;
    const sequence = ++loadSequence;
    let current = true;
    // Agent-state and report bursts often concern the same completion.
    const timer = setTimeout(async() => {
      loading.value = true;
      error.value = false;
      try {
        const archive = await loader.load(thread, chat, () => current && sequence === loadSequence);
        if (!current || sequence !== loadSequence) return;
        if (archive) stored.value = archive;
        error.value = !archive;
      } finally {
        if (current && sequence === loadSequence) loading.value = false;
      }
    }, 180);
    onCleanup(() => {
      current = false;
      clearTimeout(timer);
    });
  }, { immediate: true });

  const entries = computed(() => {
    const byJob = new Map<string, SavedOutcomeReport>();
    for (const entry of stored.value?.reports ?? []) byJob.set(ThreadGoalProgress.key(entry.item), entry);
    for (const message of controller.messages.value) {
      if (message.kind !== 'proactive') continue;
      for (const item of message.result?.items ?? []) byJob.set(ThreadGoalProgress.key(item), { item, messageId: message.id });
    }
    return [...byJob.values()];
  });
  const groups = computed(() => ThreadGoalProgress.build(threadId.value, rows.value, entries.value, [], stored.value?.history)
    .filter(group => group.steps.some(step => !!step.report)).sort((a, b) => b.at - a.at));
  const reportKeys = computed(() => entries.value.map(entry => ThreadGoalProgress.key(entry.item)));

  return {
    groups,
    reportKeys,
    error,
    loading,
    refresh: () => {
      error.value = false;
      loading.value = true;
      retry.value++;
    },
  };
}
