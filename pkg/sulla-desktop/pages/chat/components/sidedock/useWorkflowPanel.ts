// SPDX-License-Identifier: GPL-2.0-or-later
import { computed, inject, nextTick, ref, watch, type Ref } from 'vue';

import { previewEffort } from '@pkg/shared/modelLaunchPreview';
import { MODEL_ROUTING_IPC } from '@pkg/agent/languagemodels/modelRoutingTypes';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentTreeBuilder } from '@pkg/services/agentState/AgentTreeBuilder';
import type { AgentModelStatusValue } from '@pkg/shared/agentState/AgentModelStatus';
import { WORKFLOW_STEPS, type ChatModelPickerSelection, type ProductOwnerStep, type WorkflowChoice, type WorkflowPlan, type WorkflowRunRow } from '@pkg/shared/productOwnerWorkflow';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { ModelCandidate } from '@pkg/agent/languagemodels/modelRouter';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

export interface WorkflowPanelProps {
  view: 'activity' | 'team';
  outcomeKeys?: readonly string[];
  leadAt?: number;
}

export class WorkflowPanelController {
  static create(props: WorkflowPanelProps) {
    const client = inject(AGENT_STATE_CLIENT_KEY, null);
    const { backendThreadId: threadId, modelPicker } = inject<{
      backendThreadId: Ref<string | undefined>;
      modelPicker?: Ref<ChatModelPickerSelection | undefined>;
    }>('chat:activity-context', { backendThreadId: ref(undefined) });
    const plan = ref<WorkflowPlan>();
    const error = ref('');
    const saving = ref(false);
    const editing = ref(false);
    const mode = computed(() => (props.view === 'team' ? 'plan' : 'run'));
    const heading = computed(() => (props.view === 'team' ? 'AI Team' : 'Full history'));
    const selectedStep = ref<ProductOwnerStep>('implementation');
    const selectedTitle = ref('Implementation');
    const draft = ref<WorkflowChoice>({ candidates: [] });
    const planDetails = ref<HTMLElement>();
    const selectedRun = ref('');
    const runDetails = ref<HTMLElement>();
    const refreshedLeadModels = ref<AgentModelStatusValue[]>();
    const receipt = ref<AgentModelStatusValue[]>([]);
    const receiptLoading = ref(false);
    const receiptError = ref('');
    const savedHistory = ref<WorkflowRunRow[]>([]);
    const historyLoading = ref(false);
    const historyError = ref(false);
    let loadSequence = 0;
    let historySequence = 0;

    const planEntry = computed(() => plan.value?.steps[selectedStep.value]);
    const eligibleAgents = computed(() => plan.value?.agents.filter((agent) => planEntry.value?.allowedAgents.includes(agent.slug) || planEntry.value?.choice.agentSlug === agent.slug) ?? []);
    let draftRevision = '';
    const hasOverride = computed(() => Boolean(planEntry.value?.choice.agentSlug || planEntry.value?.choice.candidates.length));
    const providerNames: Record<string, string> = {
      'claude-code': 'Claude Code',
      codex: 'OpenAI Codex',
      grok: 'Grok OAuth',
    };
    const providerName = (id?: string) => (id ? plan.value?.providers.find((provider) => provider.id === id)?.name || providerNames[id] || id : '');
    const agentName = (id?: string | null) => (id ? plan.value?.agents.find((agent) => agent.slug === id)?.name || id : 'Sulla');
    const effortLabel = (value?: string) => (value ? (value === 'xhigh' ? 'Extra high' : value[0].toUpperCase() + value.slice(1)) : 'Default');
    const candidateKey = (candidate: ModelCandidate) => `${candidate.provider}/${candidate.model}`;
    const findModel = (candidate: ModelCandidate) => plan.value?.providers.find((provider) => provider.id === candidate.provider)?.models.find((model) => model.id === candidate.model);
    const candidateText = (candidate: ModelCandidate) => (findModel(candidate)?.label ?? candidate.model) + ' · ' + previewEffort(candidate, plan.value?.providers);
    const efforts = (candidate: ModelCandidate) => findModel(candidate)?.efforts?.map((effort) => effort.id) ?? [];
    const modelOptions = computed(() =>
      (plan.value?.providers ?? [])
        .filter((provider) => provider.connected && Object.hasOwn(providerNames, provider.id) && (!provider.accessMethod || ['subscription-cli', 'subscription', 'oauth-account', 'cli-account'].includes(provider.accessMethod)))
        .flatMap((provider) =>
          provider.models
            .filter((model) => !model.unverified)
            .map((model) => ({
              model: model.id,
              provider: provider.id,
              label: `${model.label} · ${provider.name}`,
              key: `${provider.id}/${model.id}`,
            }))
        )
    );
    const stages = computed(() => {
      const base = WORKFLOW_STEPS.map((step) => {
        const data = plan.value?.steps[step.id];
        const preview = data?.preview;
        const configured = preview?.candidates[0];
        const state = preview?.status;
        return {
          id: step.id,
          key: step.id as string,
          title: step.title,
          child: step.id === 'implementation' || step.id === 'review',
          optional: step.id === 'mockup' ? 'If UI design is needed' : step.id === 'review' ? 'Optional' : '',
          agent: data?.choice.agentSlug || step.agent ? agentName(data?.choice.agentSlug ?? step.agent) : 'Chosen by the build lead',
          model: state === 'waiting' ? 'Waiting for connection' : state === 'blocked' ? 'Launch blocked' : state === 'deferred' ? 'At handoff' : configured ? candidateText(configured) : 'Preview unavailable',
          provider: state === 'deferred' && configured ? 'Conditional · ' + candidateText(configured) : configured ? [providerName(configured.provider), preview!.candidates.length > 1 ? preview!.candidates.length - 1 + ' fallback' + (preview!.candidates.length > 2 ? 's' : '') : ''].filter(Boolean).join(' · ') : '',
        };
      });
      return [...base, { ...base[0], key: 'handoff', title: 'Demo & handoff' }];
    });
    const liveRows = computed(() => new Map((client?.snapshot.value.rows ?? []).filter((row) => row.rootThreadId === threadId.value).map((row) => [row.key, row])));
    const history = computed(() => {
      if (!threadId.value) return { all: [], active: [], past: [] };
      const rows = new Map(savedHistory.value.map((row) => [row.key, row]));
      for (const row of liveRows.value.values()) {
        const saved = rows.get(row.key);
        if (saved && ['done', 'failed', 'stopped'].includes(saved.state)) {
          rows.set(row.key, {
            ...row,
            ...saved,
            responseModels: saved.responseModels?.length ? saved.responseModels : row.responseModels,
          });
        } else {
          rows.set(row.key, {
            ...saved,
            ...row,
            responseModels: row.responseModels?.length ? row.responseModels : saved?.responseModels,
          });
        }
      }
      const tree = new AgentTreeBuilder<WorkflowRunRow>([...rows.values()]);
      const branches = tree.forThread(threadId.value).map((root) => tree.flatten([root]));
      return {
        all: branches.flat(),
        active: branches.filter((branch) => branch.some(({ row }) => isLive(row))).flat(),
        past: branches
          .filter((branch) => !branch.some(({ row }) => isLive(row)))
          .reverse()
          .flat(),
      };
    });
    const groups = computed(() => [
      { title: 'Active handoffs', nodes: history.value.active, earlier: false },
      { title: 'Earlier handoffs', nodes: history.value.past, earlier: true },
    ]);
    const counts = computed(() => {
      const result = { working: 0, waiting: 0, returned: 0, ended: 0 };
      for (const { row } of history.value.all) {
        if (row.state === 'parked' || row.state === 'blocked') result.waiting++;
        else if (isLive(row)) result.working++;
        else if (row.state === 'done') result.returned++;
        else result.ended++;
      }
      return result;
    });
    const leadModels = computed(() => refreshedLeadModels.value ?? plan.value?.leadModels ?? []);
    const focusedRun = computed(() => {
      if (selectedRun.value && (selectedRun.value === 'lead' || history.value.all.some((node) => node.row.key === selectedRun.value))) return selectedRun.value;
      const active = history.value.active;
      const current = active.find((node) => node.row.state === 'working') ?? active.find((node) => isLive(node.row));
      return current?.row.key || (leadModels.value.length ? 'lead' : '') || history.value.past[0]?.row.key;
    });
    const runRow = computed(() => history.value.all.find((node) => node.row.key === focusedRun.value)?.row);
    const liveRun = computed(() => (runRow.value && isLive(runRow.value) ? liveRows.value.get(runRow.value.key) : undefined));
    const recordedStage = computed(() => WORKFLOW_STEPS.find((step) => step.id === runRow.value?.workflowStep)?.title);
    const currentUpdate = computed(() => liveRun.value?.waitReason || liveRun.value?.lastCheckinSummary);
    function activityRow(row: WorkflowRunRow) {
      return {
        ...row,
        lastActivityAt: liveRows.value.get(row.key)?.lastActivityAt,
      };
    }
    const parentLabel = computed(() => {
      const row = runRow.value;
      if (!row) return '';
      if (!row.parentJobId) return plan.value?.canEdit ? 'Product Owner' : 'the chat lead';
      return history.value.all.find((node) => node.row.key === `${row.parentJobId}:${row.parentTaskIndex}`)?.row.label ?? 'an earlier agent job';
    });
    const reviewedLabel = computed(() => {
      const previous = runRow.value?.followUpOf;
      return previous ? history.value.all.find((node) => node.row.key === `${previous.jobId}:${previous.taskIndex}`)?.row.label ?? 'an earlier recorded task' : '';
    });
    const shownResponses = computed(() => (focusedRun.value === 'lead' ? leadModels.value : runRow.value?.responseModels?.length ? runRow.value.responseModels : receipt.value));
    function isLive(row: WorkflowRunRow): boolean {
      return ['queued', 'working', 'parked', 'quiet', 'blocked'].includes(row.state);
    }
    function status(state: AgentStateRow['state']): string {
      return { queued: 'Queued', working: 'Working', parked: 'Waiting', quiet: 'Quiet', blocked: 'Blocked', failed: 'Failed', lost: 'Unreachable', stopped: 'Stopped', done: 'Returned' }[state];
    }
    function fallbackReason(fallback: NonNullable<AgentModelStatusValue['fallbackFrom']>): string {
      const reason = fallback.reason === 'quota' ? 'reached its usage limit' : fallback.reason === 'rate_limit' ? 'was rate-limited' : fallback.reason === 'timeout' ? 'timed out' : 'could not finish the request';
      return `Fallback after ${fallback.model || providerName(fallback.provider)} ${reason}.`;
    }
    function latestResponse(row: WorkflowRunRow): AgentModelStatusValue | undefined {
      return row.key === focusedRun.value ? shownResponses.value.at(-1) : row.responseModels?.at(-1);
    }
    function selectRun(key: string): void {
      selectedRun.value = key;
      nextTick(() => {
        const details = runDetails.value;
        const width = details?.closest('.workflow')?.clientWidth;
        if (details && width && width < 710) details.scrollIntoView?.({ block: 'nearest' });
      });
    }

    async function reload(): Promise<void> {
      const sequence = ++loadSequence;
      const id = threadId.value;
      error.value = '';
      if (!id) return;
      try {
        const includePreview = mode.value === 'plan';
        const picker = includePreview ? modelPicker?.value : undefined;
        const data = await ipcRenderer.invoke('chat-workflow:get', id, includePreview, picker && { ...picker });
        if (sequence !== loadSequence) return;
        plan.value = data;
      } catch (cause) {
        if (sequence === loadSequence) error.value = errorMessage(cause);
      }
    }
    async function reloadHistory(): Promise<void> {
      const id = threadId.value;
      if (!id || historyLoading.value) return;
      const sequence = ++historySequence;
      historyLoading.value = true;
      try {
        const rows = await ipcRenderer.invoke('chat-workflow:history', id);
        if (sequence !== historySequence) return;
        savedHistory.value = rows;
        historyError.value = false;
      } catch {
        if (sequence === historySequence) historyError.value = true;
      } finally {
        if (sequence === historySequence) historyLoading.value = false;
      }
    }
    watch(
      threadId,
      () => {
        historySequence++;
        plan.value = undefined;
        refreshedLeadModels.value = undefined;
        editing.value = false;
        selectedRun.value = '';
        savedHistory.value = [];
        historyLoading.value = false;
        historyError.value = false;
        void reload();
      },
      { immediate: true }
    );
    watch([() => modelPicker?.value?.modelSelection, () => modelPicker?.value?.providerId, () => (modelPicker?.value?.modelSelection === 'explicit' ? modelPicker.value.modelId : undefined), () => modelPicker?.value?.agentId, () => modelPicker?.value?.chatThreadId], () => {
      if (mode.value === 'plan') void reload();
    });
    watch(
      [mode, threadId],
      ([view, id], [previousView, previousId], onCleanup) => {
        if (!id) return;
        if (view === 'plan') {
          if (previousView === 'run' && previousId === id) void reload();
          let timer: ReturnType<typeof setTimeout>;
          const refreshPlan = () => {
            clearTimeout(timer);
            if (!editing.value && !saving.value)
              timer = setTimeout(() => {
                if (!editing.value && !saving.value) void reload();
              }, 250);
          };
          ipcRenderer.on?.(MODEL_ROUTING_IPC.status, refreshPlan);
          ipcRenderer.on?.(MODEL_ROUTING_IPC.changed, refreshPlan);
          window.addEventListener('focus', refreshPlan);
          onCleanup(() => {
            clearTimeout(timer);
            ipcRenderer.removeListener?.(MODEL_ROUTING_IPC.status, refreshPlan);
            ipcRenderer.removeListener?.(MODEL_ROUTING_IPC.changed, refreshPlan);
            window.removeEventListener('focus', refreshPlan);
          });
          return;
        }
        let active = true;
        let leadLoading = false;
        const refresh = async () => {
          reloadHistory();
          if (leadLoading) return;
          leadLoading = true;
          try {
            const models = await ipcRenderer.invoke('chat-workflow:execution', id, null);
            if (active) refreshedLeadModels.value = models;
          } catch {
            // Keep the last recorded lead model available during a transient read failure.
          } finally {
            leadLoading = false;
          }
        };
        refresh();
        const timer = setInterval(refresh, 6_000);
        onCleanup(() => {
          active = false;
          clearInterval(timer);
        });
      },
      { immediate: true }
    );
    watch(
      () => [mode.value, threadId.value, runRow.value?.key, runRow.value?.state] as const,
      async (_, __, onCleanup) => {
        receipt.value = [];
        receiptError.value = '';
        receiptLoading.value = false;
        const id = threadId.value;
        const row = runRow.value;
        if (mode.value !== 'run' || !id || !row || row.responseModels?.length) return;
        let current = true;
        onCleanup(() => {
          current = false;
        });
        receiptLoading.value = true;
        try {
          const models = await ipcRenderer.invoke('chat-workflow:execution', id, { jobId: row.jobId, taskIndex: row.taskIndex });
          if (current) receipt.value = models;
        } catch (cause) {
          if (current) receiptError.value = errorMessage(cause);
        } finally {
          if (current) receiptLoading.value = false;
        }
      }
    );
    function errorMessage(cause: unknown): string {
      return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    }
    function pickStep(id: ProductOwnerStep, title: string): void {
      selectedStep.value = id;
      selectedTitle.value = title;
      editing.value = false;
      error.value = '';
      void nextTick(() => {
        const details = planDetails.value;
        const width = details?.closest('.workflow')?.clientWidth;
        if (details && width && width < 710) details.scrollIntoView?.({ block: 'nearest' });
      });
    }
    function beginEdit(): void {
      const choice = planEntry.value?.choice;
      if (!choice) return;
      draftRevision = planEntry.value!.revision;
      draft.value = {
        ...choice,
        candidates: choice.candidates.map((candidate) => ({ ...candidate })),
      };
      editing.value = true;
    }
    function selectModel(index: number, event: Event): void {
      const found = modelOptions.value.find((model) => model.key === (event.target as HTMLSelectElement).value);
      if (found)
        draft.value.candidates[index] = {
          model: found.model,
          provider: found.provider,
        };
    }
    function moveUp(index: number): void {
      const [candidate] = draft.value.candidates.splice(index, 1);
      draft.value.candidates.splice(index - 1, 0, candidate);
    }
    async function save(choice: WorkflowChoice | null): Promise<void> {
      const id = threadId.value;
      const entry = planEntry.value;
      const step = selectedStep.value;
      if (!id || !entry || saving.value) return;
      if (choice?.candidates.some((candidate) => !candidate.model)) {
        error.value = 'Choose a model for each row.';
        return;
      }
      saving.value = true;
      error.value = '';
      try {
        const data = await ipcRenderer.invoke('chat-workflow:save', {
          threadId: id,
          step,
          expectedRevision: draftRevision,
          choice: choice
            ? {
                ...choice,
                candidates: choice.candidates.map((candidate) => ({
                  ...candidate,
                })),
              }
            : null,
        });
        if (threadId.value !== id) return;
        loadSequence++;
        plan.value = data;
        if (selectedStep.value === step) editing.value = false;
        if (mode.value === 'plan' && modelPicker?.value) await reload();
      } catch (cause) {
        if (threadId.value === id) error.value = errorMessage(cause);
      } finally {
        saving.value = false;
      }
    }

    return {
      activityRow, agentName, beginEdit, candidateKey, counts, currentUpdate, draft, editing, effortLabel,
      efforts, eligibleAgents, error, fallbackReason, focusedRun, groups, hasOverride, heading, history,
      historyError, historyLoading, isLive, latestResponse, leadModels, liveRun, mode, modelOptions, moveUp,
      parentLabel, pickStep, plan, planDetails, planEntry, providerName, receiptError, receiptLoading, recordedStage,
      reload, reloadHistory, reviewedLabel, runDetails, runRow, save, savedHistory, saving, selectModel, selectedRun,
      selectedStep, selectedTitle, selectRun, shownResponses, stages, status, threadId,
    };
  }
}
