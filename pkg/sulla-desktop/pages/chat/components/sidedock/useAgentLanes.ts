// SPDX-License-Identifier: GPL-2.0-or-later
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch, type Ref } from 'vue';
import { ChatDecisions } from '../../composables/useChatDecisions';
import { useChatController } from '../../controller/useChatController';
import { AgentWorkTree, type AgentWorkNode } from '../../messages/AgentWorkTree';
import { ThreadGoalProgress, type ThreadWorkstream } from '../../messages/ThreadGoalProgress';
import { agentCountSummary, deriveThreadActivity, parkedActivity } from '../../messages/threadActivity';
import { AgentActionController } from '@pkg/services/agentState/AgentActionController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentModelStatus, type AgentModelStatusValue } from '@pkg/shared/agentState/AgentModelStatus';
import { AgentStallClassification } from '@pkg/shared/agentState/AgentStallClassification';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import { DecisionAttention } from '@pkg/shared/decisionAttention';
import type { WorkflowRunRow } from '@pkg/shared/productOwnerWorkflow';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { ProactiveMessage } from '../../models/Message';

type AgentLanesProps = {
  outcomes?: ThreadWorkstream[];
  outcomesError?: boolean;
  outcomesLoading?: boolean;
  outcomeTarget?: string;
};
type AgentLanesEmit = { (event: 'show-for-you' | 'show-history' | 'retry-outcomes'): void };

export class AgentLanesBindings {
  static use(props: AgentLanesProps & { outcomes: ThreadWorkstream[] }, emit: AgentLanesEmit) {
    const controller = useChatController();
    const client = inject(AGENT_STATE_CLIENT_KEY);
    if (!client) throw new Error('AgentStateClient is not provided');
    const actions = new AgentActionController(ipcRenderer as any, client);
    const context = inject<{ backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });

    const now = ref(Date.now());
    const messaging = reactive(new Set<string>());
    const drafts = reactive<Record<string, string>>({});
    const notice = reactive<Record<string, string>>({});
    const confirmStop = ref('');
    const expanded = reactive(new Set<string>());
    const detailsPrefix = useId();
    const detailId = (key: string) => `${ detailsPrefix }-job-${ key }`;
    function toggleExpand(key: string): void {
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
    }
    const decisionStore = ChatDecisions.useChatDecisions();
    function openForYou(id?: string): void {
      decisionStore.show(id);
      emit('show-for-you');
    }
    const threadId = context.backendThreadId;
    const snapshot = computed(() => client.snapshot.value.rows);
    const scoped = computed(() => snapshot.value.filter(row => row.rootThreadId === threadId.value));
    const live = computed(() => scoped.value.filter(AgentWorkTree.live));
    const saved = ref<{ threadId?: string; rows: WorkflowRunRow[] }>({ rows: [] });
    const historySignal = computed(() => scoped.value.map(row => `${ row.key }:${ row.state }:${ row.endedAt ?? '' }`).sort().join('|'));

    // The Sulla overview keeps the current tree after its last worker returns. The
    // Full history opens from this overview; this read supplies durable tree links.
    watch([threadId, historySignal], async([id], _, onCleanup) => {
      if (!id) {
        saved.value = { rows: [] };
        return;
      }
      let cancelled = false;
      onCleanup(() => { cancelled = true });
      try {
        const rows = await ipcRenderer.invoke('chat-workflow:history', id);
        if (!cancelled && Array.isArray(rows)) saved.value = { threadId: id, rows };
      } catch {
        // A missing endpoint stays visible in the inspector as unavailable.
      }
    }, { immediate: true });

    function historyRow(row: WorkflowRunRow): AgentStateRow {
      return {
        ...row,
        visibility:         'hidden',
        depth:              0,
        threadId:           null,
        killedByHuman:      false,
        waitingOnChildren:  0,
        lastActivityAt:     row.endedAt ?? row.startedAt ?? '',
        lastCheckinAt:      null,
        lastCheckinSummary: null,
        canMessage:         false,
        canStop:            false,
        canOpen:            false,
      };
    }
    const recorded = computed(() => {
      const rows = new Map<string, AgentStateRow>();
      if (saved.value.threadId === threadId.value) {
        for (const row of saved.value.rows) rows.set(row.key, historyRow(row));
      }
      // A recent snapshot carries current controls and updates. A saved terminal
      // state wins over a delayed live snapshot that has not settled yet.
      for (const row of scoped.value) {
        const stored = rows.get(row.key);
        if (stored && !AgentWorkTree.live(stored) && AgentWorkTree.live(row)) {
          rows.set(row.key, { ...row, ...stored, responseModels: stored.responseModels?.length ? stored.responseModels : row.responseModels });
        } else {
          rows.set(row.key, { ...stored, ...row, responseModels: row.responseModels?.length ? row.responseModels : stored?.responseModels });
        }
      }
      return [...rows.values()];
    });

    const leadMessage = computed(() => controller.messages.value.findLast(message => message.kind === 'sulla'));
    function chatLeadRow(rows: readonly AgentStateRow[], activeKeys: ReadonlySet<string>): AgentStateRow | undefined {
      const id = threadId.value;
      if (!id || !rows.length) return undefined;
      const message = leadMessage.value;
      const response = message?.by?.modelStatus;
      const at = rows.map(row => row.startedAt ?? row.lastActivityAt).filter(Boolean).sort()[0]
        ?? (message?.createdAt ? new Date(message.createdAt).toISOString() : '');
      const active = controller.isRunning.value || rows.some(row => activeKeys.has(row.key));
      return {
        key:               `chat-lead-${ id }:0`,
        jobId:             `chat-lead-${ id }`,
        taskIndex:         0,
        parentJobId:       null,
        parentTaskIndex:   null,
        rootThreadId:      id,
        threadId:          id,
        depth:             0,
        agentId:           message?.by?.agent ?? 'Sulla',
        label:             'Chat lead',
        visibility:        'tab',
        state:             active ? 'working' : 'done',
        stateReason:       null,
        killedByHuman:     false,
        waitingOnChildren: activeKeys.size,
        startedAt:         at,
        endedAt:           active
          ? null
          : (message?.createdAt ? new Date(message.createdAt).toISOString() : at),
        lastActivityAt:    message?.createdAt
          ? new Date(message.createdAt).toISOString()
          : rows.map(row => row.endedAt ?? row.lastActivityAt).filter(Boolean).sort().at(-1) ?? at,
        lastCheckinAt:      null,
        lastCheckinSummary: active ? 'Coordinating this work' : null,
        responseModels:     response?.source === 'resolved' ? [response] : undefined,
        modelStatus:        response,
        canMessage:         false,
        canStop:            false,
        canOpen:            false,
      };
    }

    const workGroups = computed(() => {
      const activeKeys = new Set(live.value.map(row => row.key));
      const recentKeys = new Set(scoped.value.map(row => row.key));
      const current = AgentWorkTree.current(recorded.value, threadId.value, activeKeys, recentKeys);
      const lead = chatLeadRow(current, activeKeys);
      if (!lead) return [];
      const connected = current.map(row => AgentWorkTree.links(row).length
        ? row
        : { ...row, parentJobId: lead.jobId, parentTaskIndex: lead.taskIndex });
      const title = controller.isRunning.value || activeKeys.size ? 'Current work' : 'Latest handoff';
      return AgentWorkTree.build([lead, ...connected], threadId.value, { includeSettled: true })
        .map(group => ({ ...group, title }));
    });
    const finished = computed(() => {
      const shown = new Set(workGroups.value.flatMap(group => group.nodes.map(node => node.row.key)));
      return scoped.value.filter(row => !AgentWorkTree.live(row) && !shown.has(row.key))
        .sort((a, b) => Date.parse(b.endedAt ?? b.lastActivityAt) - Date.parse(a.endedAt ?? a.lastActivityAt));
    });

    interface WorkSection {
      key: string;
      title: string;
      summary: string;
      nodes: AgentWorkNode[];
      map: boolean;
      defaultOpen: boolean;
    }

    const sections = computed(() => {
      const list: WorkSection[] = [];
      for (const group of workGroups.value) {
        if (group.linked) {
          const layout = AgentWorkTree.layout(group.nodes);
          const agents = group.nodes.filter(node => !node.row.key.startsWith('chat-lead-')).map(node => node.row);
          const count = agents.filter(row => row.state === 'done').length;
          const active = agentCountSummary(agents);
          list.push({
            ...group, map: layout.style !== 'list',
            summary: [active, count ? `${count} returned` : ''].filter(Boolean).join(' · '), defaultOpen: true,
          });
          continue;
        }
        const oldestFirst = [...group.nodes].sort((a, b) => Date.parse(a.row.lastActivityAt) - Date.parse(b.row.lastActivityAt));
        const buckets = [
          { title: 'Quiet', nodes: oldestFirst.filter(({ row }) => row.state === 'quiet') },
          { title: 'Waiting', nodes: group.nodes.filter(({ row }) => row.state === 'parked' || row.state === 'blocked') },
          { title: 'Working', nodes: group.nodes.filter(({ row }) => row.state === 'queued' || row.state === 'working') },
        ].filter(bucket => bucket.nodes.length);
        for (const bucket of buckets) {
          list.push({
            ...bucket, key: `unlinked-${bucket.title}`, title: `${bucket.title} · unlinked`,
            summary: String(bucket.nodes.length), map: false,
            defaultOpen: bucket.title !== 'Working' || (buckets.length === 1 && bucket.nodes.length <= 4),
          });
        }
      }
      if (finished.value.length) list.push({
        key: 'finished', title: 'Finished', summary: String(finished.value.length),
        nodes: finished.value.map(row => ({ row, links: [] })), map: false, defaultOpen: false,
      });
      return list;
    });

    const panel = ref<HTMLElement>();
    const jobs = computed(() => new Map(sections.value.flatMap(section =>
      section.nodes.map(node => [node.row.key, { node, section }] as const))));
    const placements = computed(() => {
      const byJob = new Map<string, ThreadWorkstream>();
      const bySection = new Map<string, ThreadWorkstream[]>();
      const recent: ThreadWorkstream[] = [];
      const targets = new Map<string, { section?: string; job?: string }>();
      for (const outcome of props.outcomes) {
        const remaining = outcome.steps.filter(step => {
          const entry = jobs.value.get(step.key);
          if (!step.report || !entry || entry.section.key === 'finished' || ThreadGoalProgress.key(step.report) !== step.key) return true;
          byJob.set(step.key, { ...outcome, key: step.key, steps: [step] });
          targets.set(step.key, { section: entry.section.key, job: step.key });
          return false;
        });
        if (!remaining.some(step => step.report)) continue;
        const context = new Set(outcome.steps.map(step => jobs.value.get(step.key)?.section)
          .filter(section => section && section.key !== 'finished' && !section.key.startsWith('unlinked-'))
          .map(section => section!.key));
        const section = context.size === 1 ? [...context][0] : undefined;
        const group = { ...outcome, steps: remaining };
        if (section) bySection.set(section, [...bySection.get(section) ?? [], group]);
        else recent.push(group);
        for (const step of remaining) {
          if (step.report) targets.set(step.key, { section });
        }
      }
      return { byJob, bySection, recent, targets };
    });
    const outcomesByJob = computed(() => placements.value.byJob);
    const outcomesBySection = computed(() => placements.value.bySection);
    const recentOutcomes = computed(() => placements.value.recent);
    const focusedReport = computed(() => props.outcomeTarget ? placements.value.targets.get(props.outcomeTarget) : undefined);
    const focusedRecent = computed(() => !!focusedReport.value && !focusedReport.value.section);
    function focusReport(outcome: ThreadWorkstream): string | undefined {
      return outcome.steps.some(step => step.report && step.key === props.outcomeTarget) ? props.outcomeTarget : undefined;
    }

    const showEarlier = ref(false);
    const visibleRecent = computed(() => {
      if (showEarlier.value) return recentOutcomes.value;
      return recentOutcomes.value.filter((group, index) => index < 6 || (focusedRecent.value && !!focusReport(group)));
    });
    const sectionPreferences = reactive(new Map<string, boolean>());
    watch(threadId, () => {
      expanded.clear();
      showEarlier.value = false;
      sectionPreferences.clear();
    });
    watch([() => props.outcomeTarget, () => focusedReport.value?.section, () => focusedReport.value?.job, focusedRecent], async([target, section, job]) => {
      if (!target || !focusedReport.value) return;
      if (section) sectionPreferences.set(section, true);
      if (job) expanded.add(job);
      await nextTick();
      const report = [...panel.value?.querySelectorAll<HTMLElement>('[data-report-key]') ?? []]
        .find(element => element.dataset.reportKey === target);
      const headline = report?.querySelector<HTMLElement>('summary');
      headline?.scrollIntoView?.({ block: 'nearest' });
      headline?.focus({ preventScroll: true });
    }, { immediate: true, flush: 'post' });
    function sectionOpen(section: WorkSection): boolean {
      return sectionPreferences.get(section.key) ?? (section.defaultOpen || section.nodes.some(node => expanded.has(node.row.key)));
    }
    function rememberSection(section: WorkSection, event: Event): void {
      const open = (event.currentTarget as HTMLDetailsElement).open;
      if (open !== sectionOpen(section)) sectionPreferences.set(section.key, open);
    }
    async function revealJob(key: string): Promise<void> {
      const entry = jobs.value.get(key);
      if (!entry) return;
      sectionPreferences.set(entry.section.key, true);
      expanded.add(key);
      await nextTick();
      const header = [...panel.value?.querySelectorAll<HTMLButtonElement>('[data-job-key]') ?? []]
        .find(button => button.dataset.jobKey === key);
      header?.scrollIntoView?.({ block: 'nearest' });
      header?.focus({ preventScroll: true });
    }
    function jobTitle(section: WorkSection, node: AgentWorkNode): string {
      const { row } = node;
      if (section.map && row.label === section.title && row.agentId) {
        return row.agentId.replace(/(^|[-_])([a-z])/g, (_, divider: string, letter: string) => (divider ? ' ' : '') + letter.toUpperCase());
      }
      return row.label;
    }
    function nodeFor(key: string): AgentWorkNode | undefined { return jobs.value.get(key)?.node }
    function relationTitle(key: string): string {
      const entry = jobs.value.get(key);
      return entry ? jobTitle(entry.section, entry.node) : '';
    }
    function linkedQuestions(row: AgentStateRow) {
      const ids = row.decisionIds ?? [];
      return ids.length ? decisionStore.decisions.value.filter(record => ids.includes(record.id) && DecisionAttention.active(record, now.value)) : [];
    }

    const summary = computed(() => {
      const activity = deriveThreadActivity({
        running: controller.isRunning.value, messages: controller.messages.value.filter(message => !['tool_question', 'tool_approval'].includes(message.kind)),
        agents: live.value, heartbeatMinutes: controller.heartbeat?.value.intervalMinutes ?? null,
      });
      const count = decisionStore.openCount.value;
      if (!count) return activity;
      return {
        state: 'you', lead: 'Needs you',
        parts: [`${count} ${count === 1 ? 'request' : 'requests'} in Decide`, ...(activity.state === 'idle' ? [] : activity.parts)],
      };
    });

    function jobState(row: AgentStateRow): string {
      if (row.key.startsWith('chat-lead-') && row.state === 'working') return 'Coordinating';
      if (row.state === 'parked') return parkedActivity(row).state === 'idle' ? 'Idle' : 'Waiting';
      // Same rule as the status line and tab dot: quiet without confirmed liveness is stalled.
      if (AgentStallClassification.isStalled(row.state, row.runtimeAlive)) return 'No progress';
      return { queued: 'Queued', working: 'Working', quiet: 'Quiet', blocked: 'Blocked', done: 'Returned', failed: 'Failed', lost: 'Unreachable', stopped: 'Stopped' }[row.state];
    }
    function responseFor(row: AgentStateRow): AgentModelStatusValue | undefined {
      return row.responseModels?.filter(response => response.model && response.source === 'resolved').at(-1);
    }
    function formatModel(model?: AgentModelStatusValue): string {
      return model ? AgentModelStatus.label({ ...model, mapping: undefined, source: 'resolved' }) : '';
    }
    function selectionSource(row: AgentStateRow): string {
      return row.modelStatus?.mapping ?? (row.modelStatus?.source === 'requested' ? 'Requested model' : 'Selected model');
    }
    function modelCaption(row: AgentStateRow): string {
      const response = responseFor(row);
      if (response) return `Response · ${formatModel(response)}`;
      if (row.modelStatus?.model) return `${selectionSource(row)} · ${formatModel(row.modelStatus)}`;
      return 'Model output unavailable';
    }
    function resultMessageFor(row: AgentStateRow): string | undefined {
      return controller.messages.value.find((msg): msg is ProactiveMessage => msg.kind === 'proactive' &&
        !!msg.result?.items.some(item => item.jobId === row.jobId && item.taskIndex === row.taskIndex))?.id;
    }
    function jump(messageId: string): void {
      window.dispatchEvent(new CustomEvent('chat:jump-to-message', { detail: { messageId } }));
    }
    function flash(key: string, text: string): void {
      notice[key] = text;
      setTimeout(() => { if (notice[key] === text) delete notice[key]; }, 4000);
    }
    function toggleMessage(key: string): void { if (messaging.has(key)) messaging.delete(key); else messaging.add(key); }
    async function send(row: AgentStateRow): Promise<void> {
      const text = drafts[row.key]?.trim();
      if (!text) return;
      try {
        const result = await actions.message(row, text);
        flash(row.key, result.ok ? 'Sent.' : (result.stale ? 'This agent is no longer running.' : 'Could not deliver the message.'));
        if (result.ok) { drafts[row.key] = ''; messaging.delete(row.key) }
      } catch (error) { flash(row.key, error instanceof Error ? error.message : 'Could not deliver the message.') }
    }
    async function stop(row: AgentStateRow): Promise<void> {
      if (confirmStop.value !== row.key) { confirmStop.value = row.key; return }
      confirmStop.value = '';
      try {
        const result = await actions.stop(row);
        flash(row.key, result.ok ? 'Stop requested.' : 'Already stopped.');
      } catch (error) { flash(row.key, error instanceof Error ? error.message : 'Could not stop it.') }
    }
    async function openAgent(row: AgentStateRow): Promise<void> {
      const opened = await ipcRenderer.invoke('agents:open-job-in-tab' as any, row.jobId, row.rootThreadId || context.backendThreadId.value, row.taskIndex).catch(() => false);
      if (!opened) flash(row.key, 'Could not open it; it may have finished.');
    }

    let timer: ReturnType<typeof setInterval> | null = null;
    function clearConfirm(): void { confirmStop.value = '' }
    onMounted(() => {
      timer = setInterval(() => { now.value = Date.now() }, 1000);
      window.addEventListener('click', clearConfirm);
    });
    onBeforeUnmount(() => {
      if (timer) clearInterval(timer);
      window.removeEventListener('click', clearConfirm);
    });

    return {
      now, messaging, drafts, notice, confirmStop, expanded, detailId, toggleExpand, decisionStore,
      openForYou, live, recorded, finished, sections, panel, outcomesByJob, outcomesBySection,
      recentOutcomes, focusedRecent, focusReport, showEarlier, visibleRecent, sectionOpen, rememberSection,
      revealJob, jobTitle, nodeFor, relationTitle, linkedQuestions, summary, jobState, responseFor,
      formatModel, selectionSource, modelCaption, resultMessageFor, jump, toggleMessage, send, stop, openAgent,
    };
  }
}
