// SPDX-License-Identifier: GPL-2.0-or-later
import { computed, inject, onBeforeUnmount, onMounted, provide, reactive, ref, watch, type Ref, type InjectionKey } from 'vue';

import { DecisionAttention } from '@pkg/shared/decisionAttention';
import type { DecisionRecord, DecisionResponse } from '@pkg/shared/decisions';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { ToolQuestionAnswerItem, ToolQuestionItem } from '../models/Message';

export interface DecisionDraft { picks: string[][]; other: string[]; customSelected: boolean[]; }
interface DraftSource {
  id: string;
  questions?: readonly ToolQuestionItem[];
  answers?: readonly ToolQuestionAnswerItem[];
}
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
  inlineRecord(id: string, kind: DecisionRecord['kind']): DecisionRecord | undefined;
  checkingInline(id: string): boolean;
  inlineReadFailed: Readonly<Ref<boolean>>;
  refreshInline(): Promise<void>;
  busy(id: string): boolean;
  actionError(id: string): string | undefined;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  show(id?: string): void;
  draft(record: DraftSource): DecisionDraft;
  resolve(record: DecisionRecord, action: DecisionResponse['action'], answers?: DecisionResponse['answers']): Promise<void>;
  dismiss(record: DecisionRecord): Promise<void>;
}
const KEY: InjectionKey<ChatDecisionStore> = Symbol('ChatDecisionStore');

/** One scoped subscription and shared drafts per chat; changing a dock tab cannot lose an answer. */
function createStore(threadId: Ref<string | undefined>, transcriptIds?: Ref<string[]>): ChatDecisionStore {
  const decisions = ref<DecisionRecord[]>([]); const error = ref(''); const loading = ref(false); const hasMore = ref(false); const now = ref(Date.now());
  const open = ref(false); const openVersion = ref(0); const selectedId = ref<string>(); const drafts = reactive(new Map<string, DecisionDraft>());
  let cursor: { at: number; id: string } | undefined; let generation = 0; let requestVersion = 0; let eventVersion = 0; const changedAt = new Map<string, number>(); let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  function put(record: DecisionRecord, readAt?: number): void {
    if (readAt !== undefined && (changedAt.get(record.id) ?? 0) > readAt) return;
    if (readAt === undefined) changedAt.set(record.id, ++eventVersion);
    const previous = decisions.value.find(item => item.id === record.id) ?? history.get(record.id);
    applyDeliveryDraft(record, previous);
    decisions.value = [...decisions.value.filter(item => item.id !== record.id), record]
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }
  function applyDeliveryDraft(record: DecisionRecord, previous?: DecisionRecord): void {
    const draft = drafts.get(record.id);
    if (draft && record.answerDelivery === 'interrupted' && previous?.answerDelivery !== 'interrupted') {
      // An interrupted delivery makes the durable answer an editable draft again.
      const saved = makeDraft(record);
      draft.picks.splice(0, draft.picks.length, ...saved.picks);
      draft.other.splice(0, draft.other.length, ...saved.other);
      draft.customSelected.splice(0, draft.customSelected.length, ...saved.customSelected);
    }
  }
  const history = reactive(new Map<string, DecisionRecord>());
  const checked = reactive(new Set<string>());
  const checking = new Map<string, symbol>();
  const unverified = reactive(new Set<string>());
  const firstPageLoaded = ref(false);
  const inlineReadFailed = ref(false);
  const inFlight = reactive(new Map<string, symbol>());
  const actionErrors = reactive(new Map<string, string>());
  const presented = computed(() => DecisionAttention.present(decisions.value));
  const inlineRecords = computed(() => {
    const records = new Map(history);
    for (const record of decisions.value) records.set(record.id, record);
    return new Map(DecisionAttention.present([...records.values()]).map(record => [record.id, record]));
  });
  async function readTranscript(revalidate = false, page: ReadonlySet<string> = new Set()): Promise<void> {
    const owner = threadId.value;
    if (!owner || !transcriptIds || !firstPageLoaded.value) return;
    const version = generation;
    const known = inlineRecords.value;
    const ids = [...new Set(transcriptIds.value)].filter(id => {
      const record = known.get(id);
      return !page.has(id) && (!record || ChatDecisions.visibleIn(record, owner)) &&
        (revalidate || (!checked.has(id) && !checking.has(id) && !record));
    });
    if (!ids.length) return;
    const token = Symbol();
    for (const id of ids) {
      checking.set(id, token);
      if (revalidate) unverified.add(id);
    }
    inlineReadFailed.value = false;
    try {
      for (let offset = 0; offset < ids.length; offset += 500) {
        if (version !== generation || owner !== threadId.value) return;
        const batch = ids.slice(offset, offset + 500).filter(id => checking.get(id) === token);
        if (!batch.length) continue;
        const events = eventVersion;
        const records = await ipcRenderer.invoke('decisions:transcript', owner, batch);
        if (version !== generation || owner !== threadId.value) return;
        const byId = new Map(records.map(record => [record.id, record]));
        for (const id of batch) {
          if (checking.get(id) !== token || (changedAt.get(id) ?? 0) > events) continue;
          const record = byId.get(id);
          const previous = inlineRecords.value.get(id);
          if (record) {
            if (decisions.value.some(item => item.id === id)) put(record);
            else {
              applyDeliveryDraft(record, previous);
              history.set(id, record);
            }
          } else if (previous) {
            // A formerly durable card must not fall back to the legacy action route.
            unverified.add(id);
            inlineReadFailed.value = true;
            continue;
          }
          checked.add(id);
          unverified.delete(id);
        }
      }
    } catch {
      if (version === generation && owner === threadId.value) inlineReadFailed.value = true;
    } finally {
      if (version === generation) for (const id of ids) if (checking.get(id) === token) checking.delete(id);
    }
  }
  function makeDraft(record: DraftSource): DecisionDraft {
    const draft: DecisionDraft = { picks: [], other: [], customSelected: [] };
    for (const question of record.questions ?? []) {
      const selected = record.answers?.find(answer => answer.question === question.question)?.selected ?? [];
      const picks = selected.filter(value => question.options.some(option => option.label === value));
      const other = selected.filter(value => !picks.includes(value)).join(', ');
      draft.picks.push(picks);
      draft.other.push(other);
      draft.customSelected.push(!!other.trim() && (!!question.multiSelect || picks.length === 0));
    }
    return draft;
  }
  async function run(record: DecisionRecord, operation: () => Promise<void>): Promise<void> {
    const current = inlineRecords.value.get(record.id) ?? record;
    if (inFlight.has(record.id) || unverified.has(record.id) || !DecisionAttention.active(current, now.value)) throw new Error('This request is no longer available or is already being saved.');
    const token = Symbol();
    const version = generation;
    const owner = threadId.value;
    inFlight.set(record.id, token);
    actionErrors.delete(record.id);
    try {
      await operation();
    } catch (error) {
      if (version === generation && owner === threadId.value) actionErrors.set(record.id, error instanceof Error ? error.message : 'Request could not be saved.');
      throw error;
    } finally {
      if (inFlight.get(record.id) === token) inFlight.delete(record.id);
    }
  }
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  async function read(more: boolean, attempt = 0, revalidate = false): Promise<void> {
    clearTimeout(reconnectTimer);
    const owner = threadId.value; if (!owner || (more && loading.value)) return;
    const version = generation; const request = ++requestVersion; const events = eventVersion; loading.value = true; error.value = '';
    try {
      const records = await ipcRenderer.invoke('decisions:conversation', owner, more ? cursor : undefined) as DecisionRecord[];
      if (version !== generation || request !== requestVersion || owner !== threadId.value) return;
      if (!Array.isArray(records)) throw new Error('Requests could not be loaded.');
      for (const record of records) {
        put(record, events);
        unverified.delete(record.id);
        checking.delete(record.id);
      }
      if (!more) firstPageLoaded.value = true;
      const past = records.filter(record => !DecisionAttention.active(record, now.value)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      hasMore.value = past.length >= 100;
      cursor = past.length ? { at: past[0].createdAt, id: past[0].id } : undefined;
      if (!more && revalidate) await readTranscript(true, new Set(records.map(record => record.id)));
    } catch (failure) {
      if (version !== generation || request !== requestVersion) return;
      const message = failure instanceof Error ? failure.message : 'Requests could not be loaded.';
      const transient = /connection (?:terminated|timeout)|connection timeout|ECONNRESET|ECONNREFUSED|database.*(?:unavailable|starting)/i.test(message);
      if (transient && attempt < 3) {
        error.value = 'Reconnecting to your questions. Saved answers are kept.';
        reconnectTimer = setTimeout(() => { if (version === generation && owner === threadId.value) read(more, attempt + 1, revalidate) }, 1000 * 2 ** attempt);
      } else {
        error.value = transient ? 'Questions are temporarily unavailable. Saved answers are kept. Please retry.' : message;
      }
    } finally { if (version === generation && request === requestVersion) loading.value = false; }
  }
  const refresh = () => {
    // Keep a history-only action disabled from the start of recovery, not just once its exact read starts.
    for (const id of transcriptIds?.value ?? []) if (checked.has(id)) unverified.add(id);
    return read(false, 0, true);
  };
  function onChanged(_event: unknown, record: DecisionRecord): void {
    if (decisions.value.some(item => item.id === record.id) || record.conversationId === threadId.value) {
      put(record);
      checking.delete(record.id);
      unverified.delete(record.id);
    }
    // A newly delegated thread may not be present in the currently loaded records.
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (!loading.value) void read(false); }, 150);
  }
  watch(threadId, () => {
    generation++; clearTimeout(reconnectTimer);
    decisions.value = []; cursor = undefined; hasMore.value = false; open.value = false; selectedId.value = undefined;
    history.clear(); checked.clear(); checking.clear(); unverified.clear(); changedAt.clear(); inFlight.clear(); actionErrors.clear();
    firstPageLoaded.value = false; inlineReadFailed.value = false;
    void read(false);
  }, { immediate: true });
  if (transcriptIds) watch([transcriptIds, firstPageLoaded], () => { void readTranscript(); }, { immediate: true });
  ipcRenderer.on('decisions:changed', onChanged);
  const clock = setInterval(() => { now.value = Date.now() }, 1000);
  const focus = () => { void refresh(); };
  onMounted(() => window.addEventListener('focus', focus));
  onBeforeUnmount(() => { generation++; clearTimeout(reconnectTimer); clearInterval(clock); clearTimeout(refreshTimer); ipcRenderer.removeListener('decisions:changed', onChanged); window.removeEventListener('focus', focus) });
  return {
    selectedId,
    inlineRecord(id, kind) {
      const record = inlineRecords.value.get(id);
      return record?.kind === kind && threadId.value && ChatDecisions.visibleIn(record, threadId.value) ? record : undefined;
    },
    checkingInline: id => unverified.has(id) || (!inlineRecords.value.has(id) && !checked.has(id)),
    inlineReadFailed: computed(() => inlineReadFailed.value || (!!error.value && (!firstPageLoaded.value || unverified.size > 0))),
    refreshInline: refresh,
    busy: id => inFlight.has(id) || unverified.has(id),
    actionError: id => actionErrors.get(id),
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
      if (!drafts.has(record.id)) drafts.set(record.id, makeDraft(record));
      return drafts.get(record.id)!;
    },
    resolve(record, action, answers) {
      return run(record, async() => {
        const owner = threadId.value; const version = generation; const started = eventVersion;
        const result = await ipcRenderer.invoke('decisions:resolve', { id: record.id, conversationId: record.conversationId, action, ...(answers ? { answers } : {}) });
        if (!result?.settled || result.closed) throw new Error(result?.reason || 'Your answer was not recorded. Please retry.');
        if (owner !== threadId.value || version !== generation) return;
        // A delivery/settlement event can beat the response; don't overwrite newer durable state.
        if ((changedAt.get(record.id) ?? 0) <= started) put({ ...record, attention: 'answered', ...(answers ? { answers } : {}), ...(result.late ? { answerDelivery: 'queued' as const } : { status: action }) });
        await read(false);
      });
    },
    dismiss(record) {
      return run(record, async() => {
        const owner = threadId.value; const version = generation; const started = eventVersion;
        const result = await ipcRenderer.invoke('decisions:dismiss', record.id, record.conversationId);
        if (!result?.settled) throw new Error('This request changed. Refresh For You before dismissing it.');
        if (owner !== threadId.value || version !== generation) return;
        if ((changedAt.get(record.id) ?? 0) <= started) put({ ...record, attention: 'dismissed' });
        await read(false);
      });
    },
  };
}
export class ChatDecisions {
  static visibleIn(record: DecisionRecord, conversationId: string): boolean {
    return record.conversationId === conversationId || record.relatedConversationIds?.includes(conversationId) === true;
  }

  static provide(threadId: Ref<string | undefined>, transcriptIds?: Ref<string[]>): ChatDecisionStore { const store = createStore(threadId, transcriptIds); provide(KEY, store); return store }
  static useChatDecisions(): ChatDecisionStore {
    const shared = inject(KEY, null); if (shared) return shared;
    const context = inject<{ backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });
    return createStore(context.backendThreadId);
  }
}
