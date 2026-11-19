// SPDX-License-Identifier: GPL-2.0-or-later
import { computed, inject, onBeforeUnmount, onMounted, provide, reactive, ref, watch, type Ref, type InjectionKey } from 'vue';

import { DecisionAttention } from '@pkg/shared/decisionAttention';
import type { DecisionRecord, DecisionResponse } from '@pkg/shared/decisions';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export interface DecisionDraft { picks: string[][]; other: string[]; }
export interface ChatDecisionStore {
  decisions:   Ref<DecisionRecord[]>;
  openCount:   Ref<number>;
  error:       Ref<string>;
  loading:     Ref<boolean>;
  hasMore:     Ref<boolean>;
  now:         Ref<number>;
  open:        Ref<boolean>;
  openVersion: Ref<number>;
  selectedId:  Ref<string | undefined>;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  show(id?: string): void;
  draft(record: DecisionRecord): DecisionDraft;
  resolve(record: DecisionRecord, action: DecisionResponse['action'], answers?: DecisionResponse['answers']): Promise<void>;
  dismiss(record: DecisionRecord): Promise<void>;
}
const KEY: InjectionKey<ChatDecisionStore> = Symbol('ChatDecisionStore');

/** One scoped subscription and shared drafts per chat; changing a dock tab cannot lose an answer. */
function createStore(threadId: Ref<string | undefined>): ChatDecisionStore {
  const decisions = ref<DecisionRecord[]>([]); const error = ref(''); const loading = ref(false); const hasMore = ref(false); const now = ref(Date.now());
  const open = ref(false); const openVersion = ref(0); const selectedId = ref<string>(); const drafts = reactive(new Map<string, DecisionDraft>());
  let cursor: { at: number; id: string } | undefined; let generation = 0; let requestVersion = 0; let eventVersion = 0; const changedAt = new Map<string, number>(); let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const put = (record: DecisionRecord, readAt?: number) => { if (readAt !== undefined && (changedAt.get(record.id) ?? 0) > readAt) return; if (readAt === undefined) changedAt.set(record.id, ++eventVersion); decisions.value = [...decisions.value.filter(item => item.id !== record.id), record].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)) };
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  async function read(more: boolean, attempt = 0): Promise<void> {
    clearTimeout(reconnectTimer);
    const owner = threadId.value; if (!owner || (more && loading.value)) return;
    const version = generation; const request = ++requestVersion; const events = eventVersion; loading.value = true; error.value = '';
    try {
      const records = await ipcRenderer.invoke('decisions:conversation', owner, more ? cursor : undefined) as DecisionRecord[];
      if (version !== generation || request !== requestVersion || owner !== threadId.value) return;
      if (!Array.isArray(records)) throw new Error('Requests could not be loaded.');
      for (const record of records) put(record, events);
      const past = records.filter(record => !DecisionAttention.active(record, now.value)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      hasMore.value = past.length >= 100;
      cursor = past.length ? { at: past[0].createdAt, id: past[0].id } : undefined;
    } catch (failure) {
      if (version !== generation || request !== requestVersion) return;
      const message = failure instanceof Error ? failure.message : 'Requests could not be loaded.';
      const transient = /connection (?:terminated|timeout)|connection timeout|ECONNRESET|ECONNREFUSED|database.*(?:unavailable|starting)/i.test(message);
      if (transient && attempt < 3) {
        error.value = 'Reconnecting to your questions. Saved answers are kept.';
        reconnectTimer = setTimeout(() => { if (version === generation && owner === threadId.value) read(more, attempt + 1) }, 1000 * 2 ** attempt);
      } else {
        error.value = transient ? 'Questions are temporarily unavailable. Saved answers are kept. Please retry.' : message;
      }
    } finally { if (version === generation && request === requestVersion) loading.value = false; }
  }
  const refresh = () => read(false);
  const presented = computed(() => DecisionAttention.present(decisions.value));
  function onChanged(_event: unknown, record: DecisionRecord): void {
    if (decisions.value.some(item => item.id === record.id) || record.conversationId === threadId.value) put(record);
    // A newly delegated thread may not be present in the currently loaded records.
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { refresh() }, 150);
  }
  watch(threadId, () => { generation++; clearTimeout(reconnectTimer); decisions.value = []; cursor = undefined; hasMore.value = false; open.value = false; selectedId.value = undefined; refresh() }, { immediate: true });
  ipcRenderer.on('decisions:changed', onChanged);
  const clock = setInterval(() => { now.value = Date.now() }, 1000);
  const focus = () => { refresh() };
  onMounted(() => window.addEventListener('focus', focus));
  onBeforeUnmount(() => { generation++; clearTimeout(reconnectTimer); clearInterval(clock); clearTimeout(refreshTimer); ipcRenderer.removeListener('decisions:changed', onChanged); window.removeEventListener('focus', focus) });
  return {
    selectedId,
    decisions: presented,
    openCount: computed(() => presented.value.filter(record => DecisionAttention.active(record, now.value)).length),
    error,
    loading,
    hasMore,
    now,
    open,
    openVersion,
    refresh,
    loadMore:  () => read(true),
    show(id?: string) { selectedId.value = id; open.value = true; openVersion.value++ },
    draft(record) {
      let draft = drafts.get(record.id); if (!draft) {
        const saved = (record.questions ?? []).map(question => record.answers?.find(answer => answer.question === question.question)?.selected ?? []);
        draft = { picks: (record.questions ?? []).map((question, index) => saved[index].filter(value => question.options.some(option => option.label === value))), other: (record.questions ?? []).map((question, index) => saved[index].filter(value => !question.options.some(option => option.label === value)).join(', ')) }; drafts.set(record.id, draft);
      } return drafts.get(record.id)!;
    },
    async resolve(record, action, answers) {
      const owner = threadId.value; const version = generation;
      const result = await ipcRenderer.invoke('decisions:resolve', { id: record.id, conversationId: record.conversationId, action, ...(answers ? { answers } : {}) });
      if (!result?.settled || result.closed) throw new Error(result?.reason || 'Your answer was not recorded. Please retry.');
      if (owner !== threadId.value || version !== generation) return;
      put({ ...record, attention: 'answered', ...(answers ? { answers } : {}), ...(result.late ? { answerDelivery: 'queued' as const } : { status: action }) });
      await refresh();
    },
    async dismiss(record) {
      const owner = threadId.value; const version = generation;
      const result = await ipcRenderer.invoke('decisions:dismiss', record.id, record.conversationId);
      if (!result?.settled) throw new Error('This request changed. Refresh For You before dismissing it.');
      if (owner !== threadId.value || version !== generation) return;
      put({ ...record, attention: 'dismissed' }); await refresh();
    },
  };
}
export class ChatDecisions {
  static provide(threadId: Ref<string | undefined>): ChatDecisionStore { const store = createStore(threadId); provide(KEY, store); return store }
  static useChatDecisions(): ChatDecisionStore {
    const shared = inject(KEY, null); if (shared) return shared;
    const context = inject<{ backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });
    return createStore(context.backendThreadId);
  }
}
