<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <article class="work-outcome" :data-outcome-group="group.key" tabindex="-1">
    <header>
      <span class="outcome-label">{{ owned ? 'Report from this job' : recent ? 'Recent outcome' : 'Latest outcome' }}</span>
      <span class="outcome-verdict" :class="`outcome-${ResultOutcome.tone(latest.report)}`">{{ ResultOutcome.label(latest.report) }}</span>
    </header>
    <h3 v-if="!owned || latest.report.label !== latest.title">{{ latest.report.label }}</h3>
    <AgentActivityTime class="outcome-time" :at="ResultOutcome.time(latest.report)" event="Report recorded" />
    <p v-if="latest.report.outcome" class="outcome-summary">{{ latest.report.outcome }}</p>
    <p v-if="activeStep" class="outcome-follow">{{ activeStep.title }} · {{ ThreadGoalProgress.label(activeStep) }}</p>
    <details class="outcome-evidence" :open="!!focusKey || undefined">
      <summary>Evidence and reports · {{ reports.length }}</summary>
      <details v-for="step in reports" :key="step.key" class="outcome-report" :data-report-key="step.key" :open="focusKey === step.key || undefined">
        <summary>
          {{ step.report.label }}
          <span v-if="step.key !== latest.key">{{ ResultOutcome.label(step.report) }} · <AgentActivityTime :at="ResultOutcome.time(step.report)" event="Report recorded" /></span>
        </summary>
        <ul v-if="facts(step.report).length" class="outcome-facts">
          <li v-for="(fact, index) in facts(step.report)" :key="index">{{ fact }}</li>
        </ul>
        <div class="outcome-actions">
          <button v-if="step.messageId && messageIds.has(step.messageId)" type="button" @click="jump(step.messageId)">View in chat</button>
          <button v-if="step.report.threadId" type="button" @click="actions.openAgent(step.report)">Open agent</button>
          <button v-for="link in step.report.links" :key="link.url" type="button" @click="actions.openUrl(link.url)">{{ link.label }}</button>
        </div>
        <pre>{{ step.report.report }}</pre>
      </details>
    </details>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { AgentResultActions } from '../../composables/useAgentResultActions';
import { useChatController } from '../../controller/useChatController';
import { ThreadGoalProgress, type ThreadMilestone, type ThreadWorkstream } from '../../messages/ThreadGoalProgress';
import { ResultOutcome } from '../../messages/resultOutcome';
import AgentActivityTime from '../chrome/AgentActivityTime.vue';

import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';

const props = defineProps<{ group: ThreadWorkstream; recent?: boolean; owned?: boolean; focusKey?: string }>();
const actions = AgentResultActions.useAgentResultActions();
const controller = useChatController();
const messageIds = computed(() => new Set(controller.messages.value.map(message => message.id)));
const reports = computed(() => props.group.steps.filter((step): step is ThreadMilestone & { report: AgentResultItem } => !!step.report)
  .sort((a, b) => ResultOutcome.time(b.report) - ResultOutcome.time(a.report)));
const latest = computed(() => reports.value[0]);
const activeStep = computed(() => {
  if (props.owned) return undefined;
  const active = props.group.steps.filter(step => step.key !== latest.value.key && ThreadGoalProgress.active(step.row));
  return active.find(step => step.parent === latest.value.key);
});

function facts(item: AgentResultItem): string[] {
  return [
    ...(item.checks ?? []).map(check => `${check.passed ? 'Passed' : 'Failed'} · ${check.name}${check.detail ? ' · ' + check.detail : ''}`),
    ...(item.findings ?? []).map(finding => `${finding.severity} · ${finding.title}${finding.detail ? ' · ' + finding.detail : ''}`),
    ...(item.merges ?? []).map(merge => `Reported merge · ${merge.pr}${merge.sha ? ' · ' + merge.sha : ''}`),
    ...(item.environments ?? []).map(env => `${env.name} · ${env.state}${env.detail ? ' · ' + env.detail : ''}`),
  ];
}
function jump(messageId: string): void {
  window.dispatchEvent(new CustomEvent('chat:jump-to-message', { detail: { messageId } }));
}
</script>

<style scoped>
.work-outcome {
  padding: 10px 12px; border: 1px solid var(--border-default); border-left: 3px solid var(--accent);
  border-radius: 9px; color: var(--text-primary); background: color-mix(in srgb, var(--accent) 6%, var(--bg-page));
  overflow-wrap: anywhere;
}
.work-outcome:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.work-outcome header { display: flex; justify-content: space-between; gap: 6px; font-size: 11px; }
.outcome-label { font-weight: 650; color: var(--accent); }
.outcome-verdict { color: var(--text-secondary); text-align: end; }
.outcome-warning { color: var(--status-warning); }
.work-outcome h3 { margin: 4px 0; font-size: 14px; }
.outcome-time { font-size: 11px; color: var(--text-secondary); }
.outcome-summary, .outcome-follow { margin: 4px 0; font-size: 12px; color: var(--text-secondary); }
.outcome-evidence { margin-top: 7px; }
.outcome-evidence summary { cursor: pointer; color: var(--accent); font-size: 12px; }
.outcome-report { padding: 8px 0 0; margin: 8px 0 0; border-top: 1px solid var(--border-default); }
.outcome-report summary { color: var(--text-primary); }
.outcome-report summary span { color: var(--text-secondary); }
.outcome-facts { margin: 8px 0; padding-inline-start: 18px; color: var(--text-secondary); font-size: 12px; }
.outcome-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.outcome-actions button { padding: 4px 8px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-surface); color: var(--text-primary); cursor: pointer; font: inherit; font-size: 11px; }
.work-outcome pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.5 var(--font-mono, monospace); margin: 9px 0 3px; }
</style>
