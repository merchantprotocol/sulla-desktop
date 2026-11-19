// SPDX-License-Identifier: GPL-2.0-or-later
import { computed, inject, ref, shallowRef, watch, onMounted, onBeforeUnmount, type Ref, type ComputedRef } from 'vue';

import { useChatController } from '../controller/useChatController';
import { resultActivity, type ResultActivity } from '../messages/resultActivity';

import { useDecisions } from '@pkg/composables/useDecisions';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import type { AgentResultItem, ResultActivityRecord } from '@pkg/shared/agentResults/AgentResultCard';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

// One shared, throttled metadata read per manager. Activity bursts coalesce;
// a trailing read observes changes received while a request was in flight.
interface LinkRead {
  data:        Ref<ResultActivityRecord[]>;
  error:       Ref<boolean>;
  wanted:      number;
  loaded:      number;
  pending:     boolean;
  lastStarted: number;
  users:       number;
  timer?:      ReturnType<typeof setTimeout>;
}
const reads = new Map<string, LinkRead>();
function refreshLinks(owner: string, entry: LinkRead, version: number): void {
  entry.wanted = Math.max(entry.wanted, version);
  if (entry.pending || entry.timer || entry.loaded >= entry.wanted) return;
  entry.timer = setTimeout(async() => {
    entry.timer = undefined;
    entry.pending = true;
    entry.lastStarted = Date.now();
    const wanted = entry.wanted;
    try {
      const data = await ipcRenderer.invoke('agents:result-tracking', owner);
      if (!Array.isArray(data)) throw new Error('Result tracking is unavailable.');
      entry.data.value = data;
      entry.error.value = false;
    } catch { entry.error.value = true } finally {
      entry.loaded = wanted;
      entry.pending = false;
      if (entry.users && entry.wanted > wanted) refreshLinks(owner, entry, entry.wanted);
    }
  }, Math.max(0, 2000 - (Date.now() - entry.lastStarted)));
}

/** Reuses existing read-only decision and agent-state subscriptions. */
export function useResultActivity() {
  const client = inject(AGENT_STATE_CLIENT_KEY, null);
  const { records: decisions, error } = useDecisions();
  const context = inject<{ backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });
  let controller: ReturnType<typeof useChatController> | undefined;
  try { controller = useChatController() } catch { /* standalone card */ }
  const read = shallowRef<LinkRead>();
  let owner: string | undefined;
  function release() {
    if (!read.value) return;
    if (--read.value.users === 0 && read.value.timer) { clearTimeout(read.value.timer); read.value.timer = undefined }
  }
  watch(() => [context.backendThreadId.value, client?.snapshot.value.version] as const, ([nextOwner, version]) => {
    if (owner !== nextOwner) {
      release();
      owner = nextOwner;
      read.value = undefined;
      if (owner) {
        let entry = reads.get(owner);
        if (!entry) {
          entry = { data: ref([]), error: ref(false), wanted: -2, loaded: -2, pending: false, lastStarted: 0, users: 0 };
          reads.set(owner, entry);
        }
        entry.users++;
        read.value = entry;
        if (reads.size > 32) for (const [key, value] of reads) if (!value.users && !value.pending) { reads.delete(key); break }
      }
    }
    if (owner && read.value) refreshLinks(owner, read.value, version ?? -1);
  }, { immediate: true });
  const retry = () => { if (owner && read.value) refreshLinks(owner, read.value, read.value.wanted + 1); };
  onMounted(() => { window.addEventListener('focus', retry); window.addEventListener('online', retry) });
  onBeforeUnmount(() => { release(); window.removeEventListener('focus', retry); window.removeEventListener('online', retry) });
  const records = computed(() => read.value?.data.value ?? []);
  const items = computed(() => (controller?.messages.value ?? []).flatMap(message => message.kind === 'proactive' ? message.result?.items ?? [] : []));
  const rows = computed(() => {
    const owner = context.backendThreadId.value;
    if (!owner) return [];
    const owned = new Set(records.value.map(record => `${ record.jobId }:${ record.taskIndex }`));
    return (client?.snapshot.value.rows ?? []).filter(row => row.rootThreadId === owner || owned.has(row.key));
  });
  const views = new WeakMap<AgentResultItem, ComputedRef<ResultActivity>>();
  return {
    error:    computed(() => !!read.value?.error.value),
    refresh:  retry,
    rows,
    records,
    activity: (item: AgentResultItem) => {
      let view = views.get(item);
      if (!view) {
        view = computed(() => resultActivity(item, {
          rows:          rows.value,
          items:         items.value,
          records:       records.value,
          ownerThreadId: context.backendThreadId.value,
          decisions:     decisions.value,
          unavailable:   !!read.value?.error.value || !!client?.error?.value || !!error?.value,
        }));
        views.set(item, view);
      }
      return view.value;
    },
  };
}
