<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <section
    class="outcomes"
    aria-label="Results from this chat"
  >
    <header class="outcomes-head">
      <h2>Results</h2><button
        type="button"
        :disabled="refreshing"
        @click="refresh"
      >
        Refresh
      </button>
    </header>
    <p
      v-if="readError"
      class="outcomes-warning"
      role="alert"
    >
      Some updates could not be checked. Your recorded reports remain here. <button
        type="button"
        @click="refresh"
      >
        Retry
      </button>
    </p>
    <p
      v-if="!groups.length"
      class="outcomes-empty"
    >
      {{ hasWork ? 'Waiting for the first report.' : 'No results in this chat yet.' }} <button
        v-if="hasWork"
        type="button"
        @click="emit('show-activity')"
      >
        View Sulla
      </button>
    </p>
    <p
      v-else
      class="outcomes-muted"
    >
      Latest returned work · {{ entries.length }} {{ entries.length === 1 ? 'report' : 'reports' }}
    </p>
    <template
      v-for="(stream, index) in groups"
      :key="stream.key"
    >
      <OutcomeGroup
        v-if="index < 6 || earlierOpen"
        :group="stream"
      />
    </template>
    <details
      v-if="groups.length > 6"
      class="outcomes-earlier"
      :open="earlierOpen"
      @toggle="earlierOpen = ($event.target as HTMLDetailsElement).open"
    >
      <summary>{{ earlierOpen ? 'Showing earlier results' : `Earlier results · ${groups.length - 6}` }}</summary>
    </details>
  </section>
</template>
<script setup lang="ts">
import { computed, defineComponent, h, inject, ref, watch, type PropType, type Ref } from 'vue';

import { AgentResultActions } from '../../composables/useAgentResultActions';
import { useResultActivity } from '../../composables/useResultActivity';
import { useChatController } from '../../controller/useChatController';
import { ThreadGoalProgress, type ThreadWorkstream } from '../../messages/ThreadGoalProgress';
import { ResultOutcome } from '../../messages/resultOutcome';
import { allResults, groupResults } from '../../messages/sideDock';

import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentModelStatus } from '@pkg/shared/agentState/AgentModelStatus';
const emit = defineEmits<(event: 'show-activity') => void>();
const controller = useChatController();
const client = inject(AGENT_STATE_CLIENT_KEY, null);
const context = inject<{ backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });
const { activity, records, error: linksError, refresh: refreshLinks } = useResultActivity();
const actions = AgentResultActions.useAgentResultActions();
const entries = computed(() => allResults(groupResults(controller.messages.value, activity)));
const rows = computed(() => ThreadGoalProgress.scope(context.backendThreadId.value, client?.snapshot.value.rows ?? [], entries.value));
const groups = computed(() => ThreadGoalProgress.build(context.backendThreadId.value, rows.value, entries.value, records.value).filter(group => group.steps.some(step => step.report)).sort((a, b) => reportTime(b) - reportTime(a)));
const hasWork = computed(() => controller.isRunning.value || rows.value.some(row => ThreadGoalProgress.active(row)));
const readError = computed(() => !!linksError.value || !!client?.error?.value);
const earlierOpen = ref(false); const refreshing = ref(false);
watch(context.backendThreadId, () => { earlierOpen.value = false });
function reportTime(group: ThreadWorkstream): number { return Math.max(...group.steps.map(step => step.report ? ResultOutcome.time(step.report) : 0)) }
async function refresh(): Promise<void> { refreshing.value = true; try { refreshLinks(); await client?.resync() } finally { refreshing.value = false } }
function jump(messageId: string) { window.dispatchEvent(new CustomEvent('chat:jump-to-message', { detail: { messageId } })) }

// One reusable presentation for the latest report and its explicitly linked earlier attempts.
const OutcomeGroup = defineComponent({
  props: { group: { type: Object as PropType<ThreadWorkstream>, required: true } },
  setup(props) {
    return () => {
      const returned = props.group.steps.filter(step => step.report).sort((a, b) => ResultOutcome.time(b.report!) - ResultOutcome.time(a.report!));
      const step = returned[0]; const item = step.report!;
      const live = props.group.steps.find(step => ThreadGoalProgress.active(step.row));
      const evidence = [
        ...(item.checks ?? []).map(check => h('p', `${ check.passed ? 'Passed' : 'Failed' } · ${ check.name }${ check.detail ? ': ' + check.detail : '' }`)),
        ...(item.findings ?? []).map(finding => h('p', `${ finding.severity } · ${ finding.title }${ finding.detail ? ': ' + finding.detail : '' }${ finding.file ? ' · ' + finding.file : '' }`)),
        ...(item.merges ?? []).map(merge => h('p', `Reported merge · ${ merge.pr }${ merge.sha ? ' · ' + merge.sha : '' }`)),
        ...(item.environments ?? []).map(environment => h('p', `${ environment.name } · ${ environment.state }${ environment.detail ? ': ' + environment.detail : '' }`)),
      ];
      return h('article', { class: 'outcome' }, [
        h('div', { class: ['outcome-status', 'outcome-' + ResultOutcome.tone(item)] }, ResultOutcome.label(item)),
        h('h3', item.label), h('p', { class: 'outcome-summary' }, item.outcome),
        ResultOutcome.time(item) ? h('time', { datetime: new Date(item.endedAt).toISOString() }, new Date(item.endedAt).toLocaleString()) : null,
        h('div', { class: 'outcome-actions' }, [
          step.messageId ? h('button', { type: 'button', onClick: () => jump(step.messageId!) }, 'View report') : null,
          item.threadId || step.row?.threadId ? h('button', { type: 'button', onClick: () => actions.openAgent({ threadId: item.threadId ?? step.row?.threadId, agentId: item.agentId, label: item.label }) }, 'Open agent') : null,
          ...(item.links ?? []).map(link => h('button', { type: 'button', onClick: () => actions.openUrl(link.url) }, link.label)),
        ]),
        live ? h('p', { class: 'outcomes-muted' }, `Linked follow-up: ${ live.title } · ${ ThreadGoalProgress.label(live) }`) : null,
        h('details', { class: 'outcome-evidence' }, [h('summary', 'Recorded evidence and model'), ...evidence, h('p', AgentModelStatus.label(item.modelStatus)), h('pre', item.report)]),
        returned.length > 1 ? h('details', { class: 'outcome-earlier' }, [h('summary', `${ returned.length - 1 } earlier linked reports`), ...returned.slice(1).map(earlier => h('div', { class: 'outcome-attempt' }, [h('strong', earlier.title), h('p', ResultOutcome.label(earlier.report!)), h('p', earlier.report!.outcome), h('details', [h('summary', 'Original report'), h('pre', earlier.report!.report)])]))]) : null,
      ]);
    };
  },
});
</script>
<style scoped>
.outcomes{padding:20px;color:var(--text-primary);font-family:var(--font-body)}.outcomes-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.outcomes h2{font-size:21px;margin:0}.outcomes-muted,.outcomes-empty{color:color-mix(in srgb,var(--text-primary) 72%,var(--bg-surface));font-size:12px}.outcomes-empty{padding:26px 0}.outcomes-warning{font-size:12px;color:var(--status-warning)}.outcomes :deep(button){font:inherit;font-size:12px;background:transparent;color:inherit;border:1px solid var(--border-strong);border-radius:7px;padding:7px 10px;cursor:pointer}.outcomes :deep(button:focus-visible),.outcomes :deep(summary:focus-visible){outline:2px solid var(--accent);outline-offset:3px}.outcomes :deep(.outcome){border-bottom:1px solid var(--border-default);padding:20px 0}.outcomes :deep(h3){font-size:15px;line-height:1.5;margin:6px 0}.outcomes :deep(.outcome-status){font-size:12px;color:var(--text-secondary)}.outcomes :deep(.outcome-warning){color:var(--status-warning)}.outcomes :deep(.outcome-summary){font-size:14px;line-height:1.6;overflow-wrap:anywhere;margin:8px 0 12px}.outcomes :deep(time){font-size:11px;color:var(--text-muted)}.outcomes :deep(.outcome-actions){display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.outcomes :deep(details){font-size:12px;margin-top:14px;color:var(--text-secondary)}.outcomes :deep(summary){cursor:pointer}.outcomes :deep(pre){white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.outcomes :deep(.outcome-attempt){padding:14px 0;border-bottom:1px solid var(--border-default)}.outcomes-earlier{margin-top:20px;font-size:13px}
</style>
