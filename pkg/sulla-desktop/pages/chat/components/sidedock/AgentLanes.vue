<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Recorded handoffs and unlinked activity for the current chat.
-->
<template>
  <div ref="panel" class="ln">
    <p class="ln-sum" :class="`ln-sum-${summary.state}`">
      <span class="ln-sum-dot" aria-hidden="true" /><b>{{ summary.lead }}</b>
      <template v-for="part in summary.parts" :key="part">
        <span class="ln-sum-sep">·</span>{{ part }}
      </template>
    </p>
    <button
      v-if="recorded.length"
      type="button"
      class="ln-history"
      @click="emit('show-history')"
    >View full history</button>
    <button
      v-if="decisionStore.openCount.value"
      type="button"
      class="ln-for-you"
      @click="openForYou()"
    >
      Open Decide
    </button>
    <p v-if="outcomesLoading && outcomes.length" class="ln-outcome-refresh" role="status">
      Refreshing saved outcomes…
    </p>
    <p v-else-if="outcomesError" class="ln-outcome-error" role="status">
      Saved outcome history may be stale. <button type="button" @click="emit('retry-outcomes')">Try again</button>
    </p>
    <div v-if="!live.length && !finished.length && !decisionStore.openCount.value && !outcomes.length && !outcomesLoading && !outcomesError" class="ln-empty">
      No agent activity in this chat.
    </div>
    <details
      v-for="section in sections"
      :key="section.key"
      class="ln-work"
      :open="sectionOpen(section)"
      @toggle="rememberSection(section, $event)"
    >
      <summary class="ln-work-heading">
        <span>{{ section.title }}</span><small>{{ section.summary }}</small>
      </summary>
      <div class="ln-work-body">
        <AgentHandoffMap :nodes="section.nodes" :draw-links="section.map" v-slot="{ node }">
          <div v-if="node.links.length" class="ln-relationships">
            <div v-for="link in node.links" :key="`${link.kind}-${link.key}`">
              {{ link.kind === 'assignment' ? 'Assigned by' : 'Follows' }}
              <button v-if="nodeFor(link.key)" type="button" class="ln-link" @click="revealJob(link.key)">
                {{ relationTitle(link.key) }}
              </button>
              <span v-else>earlier job unavailable</span>
            </div>
          </div>
          <div class="ln-job-card" :class="{ 'ln-job-open': expanded.has(node.row.key) }">
            <button
              type="button"
              class="ln-job"
              :aria-expanded="expanded.has(node.row.key)"
              :aria-controls="detailId(node.row.key)"
              :data-job-key="node.row.key"
              @click="toggleExpand(node.row.key)"
            >
              <span class="ln-chevron" aria-hidden="true" />
              <span class="ln-job-title" :title="node.row.label">{{ jobTitle(section, node) }}</span>
              <span class="ln-job-state" :class="`ln-job-${node.row.state}`">{{ jobState(node.row) }}</span>
              <span class="ln-job-meta">
                {{ modelCaption(node.row) }}<span class="ln-time"><AgentActivityTime :row="node.row" /></span>
                <template v-if="node.row.state === 'parked' && node.row.wakeAt"> · Next check <AgentActivityTime :at="node.row.wakeAt" event="Next check" /></template>
                <template v-if="outcomesByJob.has(node.row.key)"> · 1 report</template>
              </span>
            </button>
            <div v-show="expanded.has(node.row.key)" :id="detailId(node.row.key)" class="ln-detail">
              <template v-if="expanded.has(node.row.key)">
                <p v-if="node.row.stateReason || node.row.lastCheckinSummary || AgentWorkTree.live(node.row)" class="ln-latest">
                  {{ laneStep(node.row, now) }}
                </p>
                <dl class="ln-more">
                  <dt>Agent</dt><dd>{{ node.row.agentId || 'Agent' }}</dd>
                  <template v-if="node.row.taskId">
                    <dt>Project task</dt><dd>{{ node.row.taskId }}</dd>
                  </template>
                  <template v-if="node.row.modelStatus?.model && responseFor(node.row)">
                    <dt>{{ selectionSource(node.row) }}</dt><dd>{{ formatModel(node.row.modelStatus) }}</dd>
                  </template>
                  <template v-if="!responseFor(node.row)">
                    <dt>Recorded response</dt><dd>No model output recorded</dd>
                  </template>
                  <template v-if="node.row.jobRestartResumeCount">
                    <dt>Job recovery</dt><dd>Resumed {{ node.row.jobRestartResumeCount }} {{ node.row.jobRestartResumeCount === 1 ? 'time' : 'times' }}</dd>
                  </template>
                  <template v-for="decision in linkedQuestions(node.row)" :key="decision.id">
                    <dt>Related request</dt>
                    <dd><button type="button" class="ln-link" @click="openForYou(decision.id)">{{ decision.title || 'Open Decide' }}</button></dd>
                  </template>
                </dl>
                <div class="ln-actions">
                  <button v-if="node.row.canOpen" type="button" @click="openAgent(node.row)">Open agent</button>
                  <button v-if="node.row.canMessage" type="button" @click="toggleMessage(node.row.key)">Message</button>
                  <button v-if="node.row.canStop" type="button" class="ln-stop" @click.stop="stop(node.row)">
                    {{ confirmStop === node.row.key ? 'Click again to stop' : 'Stop agent' }}
                  </button>
                  <button v-if="resultMessageFor(node.row)" type="button" @click="jump(resultMessageFor(node.row)!)">View report</button>
                </div>
                <div v-if="node.row.canMessage && messaging.has(node.row.key)" class="ln-msg">
                  <input
                    v-model="drafts[node.row.key]"
                    :aria-label="`Message ${node.row.agentId || 'agent'}`"
                    placeholder="Message this agent"
                    @keydown.enter="send(node.row)"
                  >
                  <button type="button" :disabled="!drafts[node.row.key]?.trim()" @click="send(node.row)">Send</button>
                </div>
                <p v-if="notice[node.row.key]" class="ln-notice" role="status">{{ notice[node.row.key] }}</p>
                <WorkOutcomeCard
                  v-if="outcomesByJob.get(node.row.key)"
                  class="ln-job-report"
                  :group="outcomesByJob.get(node.row.key)!"
                  :focus-key="outcomeTarget === node.row.key ? outcomeTarget : undefined"
                  owned
                />
              </template>
            </div>
          </div>
        </AgentHandoffMap>
        <div v-if="outcomesBySection.get(section.key)?.length" class="ln-outcomes ln-build-outcomes">
          <h3>Reports for this work</h3>
          <WorkOutcomeCard
            v-for="outcome in outcomesBySection.get(section.key)"
            :key="outcome.key"
            :group="outcome"
            :focus-key="focusReport(outcome)"
          />
        </div>
      </div>
    </details>
    <details v-if="recentOutcomes.length" class="ln-work ln-recent-outcomes" :open="!live.length || !!focusedRecent">
      <summary class="ln-work-heading"><span>Recent outcomes</span><small>{{ recentOutcomes.length }}</small></summary>
      <div class="ln-work-body ln-outcomes">
        <WorkOutcomeCard
          v-for="outcome in visibleRecent"
          :key="outcome.key"
          :group="outcome"
          :focus-key="focusReport(outcome)"
          recent
        />
        <button v-if="recentOutcomes.length > visibleRecent.length" type="button" class="ln-earlier-outcomes" @click="showEarlier = true">
          Show earlier outcomes · {{ recentOutcomes.length - visibleRecent.length }}
        </button>
      </div>
    </details>
    <p v-else-if="outcomesLoading && !outcomes.length" class="ln-empty" role="status">Loading saved outcomes…</p>
  </div>
</template>

<script setup lang="ts">
import AgentHandoffMap from './AgentHandoffMap.vue';
import WorkOutcomeCard from './WorkOutcomeCard.vue';
import { laneStep } from '../../messages/sideDock';
import AgentActivityTime from '../chrome/AgentActivityTime.vue';
import { AgentWorkTree } from '../../messages/AgentWorkTree';
import type { ThreadWorkstream } from '../../messages/ThreadGoalProgress';
import { AgentLanesBindings } from './useAgentLanes';

const props = withDefaults(defineProps<{
  outcomes?: ThreadWorkstream[];
  outcomesError?: boolean;
  outcomesLoading?: boolean;
  outcomeTarget?: string;
}>(), { outcomes: () => [] });
const emit = defineEmits<{ (event: 'show-for-you' | 'show-history' | 'retry-outcomes'): void }>();
const {
  now, messaging, drafts, notice, confirmStop, expanded, detailId, toggleExpand, decisionStore,
  openForYou, live, recorded, finished, sections, panel, outcomesByJob, outcomesBySection,
  recentOutcomes, focusedRecent, focusReport, showEarlier, visibleRecent, sectionOpen, rememberSection,
  revealJob, jobTitle, nodeFor, relationTitle, linkedQuestions, summary, jobState, responseFor,
  formatModel, selectionSource, modelCaption, resultMessageFor, jump, toggleMessage, send, stop, openAgent,
} = AgentLanesBindings.use(props, emit);
</script>

<style scoped src="../../styles/agent-lanes.css"></style>
