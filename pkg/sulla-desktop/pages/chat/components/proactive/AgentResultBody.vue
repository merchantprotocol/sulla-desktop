<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  The purpose-shaped rows of an agent result: merges and environments, QA
  tally and failed checks, review findings, or the change a fix made. Long
  lists show a few rows; the card remembers which lists were expanded.
-->
<template>
  <div
    v-if="hasBody"
    class="ar-body"
  >
    <!-- Merge and deploy -->
    <template v-if="item.merges?.length">
      <span class="ar-label">Merged</span>
      <div class="ar-rows">
        <div
          v-for="merge in shown(item.merges, 'merges')"
          :key="merge.pr + (merge.sha || '')"
          class="ar-row ar-r-merge"
        >
          <span class="ar-mono">{{ merge.pr }}</span>
          <span class="ar-t">{{ merge.title || '' }}</span>
          <span
            v-if="merge.sha"
            class="ar-sha"
          >{{ merge.sha }}</span>
        </div>
        <button
          v-if="hidden(item.merges, 'merges')"
          type="button"
          class="ar-more"
          @click="emit('expand', 'merges')"
        >
          Show {{ hidden(item.merges, 'merges') }} more
        </button>
      </div>
    </template>
    <template v-if="item.environments?.length">
      <span class="ar-label">Environments</span>
      <div class="ar-rows">
        <div
          v-for="env in item.environments"
          :key="env.name"
          class="ar-row ar-r-env"
        >
          <span>{{ env.name }}</span>
          <span class="ar-t">{{ env.detail || '' }}</span>
          <span
            class="ar-chip"
            :class="`ar-${ENV_TONE[env.state]}`"
          >{{ ENV_LABEL[env.state] }}</span>
        </div>
      </div>
    </template>

    <!-- QA -->
    <p
      v-if="item.tally"
      class="ar-tally"
    >
      <span v-if="item.tally.passed !== undefined"><b class="ar-ok-t">{{ item.tally.passed }}</b> passed</span>
      <span v-if="item.tally.failed !== undefined"><b :class="{ 'ar-bad-t': item.tally.failed > 0 }">{{ item.tally.failed }}</b> failed</span>
      <span v-if="item.tally.skipped"><b>{{ item.tally.skipped }}</b> skipped</span>
    </p>
    <template v-if="failedChecks.length">
      <span class="ar-label">Failed</span>
      <div class="ar-rows">
        <div
          v-for="check in failedChecks"
          :key="check.name"
          class="ar-row ar-r-check"
        >
          <svg
            class="ar-ico ar-bad-t"
            viewBox="0 0 16 16"
            aria-hidden="true"
          ><path d="M4 4l8 8M12 4l-8 8" /></svg>
          <span class="ar-t"><b>{{ check.name }}</b><template v-if="check.detail"> · {{ check.detail }}</template></span>
        </div>
      </div>
    </template>

    <!-- Review -->
    <template v-if="item.findings?.length">
      <span class="ar-label">Findings</span>
      <div class="ar-rows">
        <div
          v-for="(finding, fi) in shown(item.findings, 'findings')"
          :key="fi"
          class="ar-row ar-r-find"
        >
          <span
            class="ar-chip"
            :class="`ar-${SEVERITY_TONE[finding.severity]}`"
          >{{ finding.severity }}</span>
          <span class="ar-t"><b>{{ finding.title }}</b>{{ finding.detail ? ` ${finding.detail}` : '' }}<template v-if="finding.file"> · <span class="ar-file">{{ finding.file }}</span></template></span>
        </div>
        <button
          v-if="hidden(item.findings, 'findings')"
          type="button"
          class="ar-more"
          @click="emit('expand', 'findings')"
        >
          Show {{ hidden(item.findings, 'findings') }} more
        </button>
      </div>
    </template>

    <!-- Fix -->
    <template v-if="item.change">
      <p class="ar-tally">
        <span v-if="item.change.pr"><b>{{ item.change.pr }}</b></span>
        <span v-else-if="item.change.branch"><span class="ar-file">{{ item.change.branch }}</span></span>
        <span v-if="item.change.filesChanged !== undefined"><b>{{ item.change.filesChanged }}</b> files changed</span>
        <span v-if="item.change.added !== undefined || item.change.removed !== undefined"><b class="ar-ok-t">+{{ item.change.added ?? 0 }}</b> <b class="ar-bad-t">−{{ item.change.removed ?? 0 }}</b></span>
        <span v-if="item.change.tests">Tests <b>{{ item.change.tests }}</b></span>
        <span v-if="item.change.ci">CI <b>{{ item.change.ci }}</b></span>
      </p>
      <div
        v-if="item.change.files?.length"
        class="ar-rows"
      >
        <div
          v-for="file in item.change.files.slice(0, 5)"
          :key="file"
          class="ar-row ar-r-file"
        >
          <span class="ar-file">{{ file }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { AgentResultEnvironment, AgentResultFinding, AgentResultItem, AgentResultTone } from '@pkg/shared/agentResults/AgentResultCard';

const props = defineProps<{ item: AgentResultItem; expanded: readonly string[] }>();
const emit = defineEmits<(e: 'expand', kind: string) => void>();

const ENV_TONE: Record<AgentResultEnvironment['state'], AgentResultTone> = { deployed: 'ok', failed: 'bad', pending: 'info', held: 'dim' };
const ENV_LABEL: Record<AgentResultEnvironment['state'], string> = { deployed: 'Deployed', failed: 'Failed', pending: 'In progress', held: 'Not released' };
const SEVERITY_TONE: Record<AgentResultFinding['severity'], AgentResultTone> = { blocking: 'bad', major: 'warn', minor: 'dim' };
const ROW_LIMIT = 4;

const failedChecks = computed(() => (props.item.checks ?? []).filter(check => !check.passed));
const hasBody = computed(() => {
  const item = props.item;
  return !!(item.merges?.length || item.environments?.length || item.tally || failedChecks.value.length || item.findings?.length || item.change);
});

function shown<T>(list: T[], kind: string): T[] {
  return props.expanded.includes(kind) ? list : list.slice(0, ROW_LIMIT);
}
function hidden(list: unknown[] | undefined, kind: string): number {
  return !list || props.expanded.includes(kind) ? 0 : Math.max(0, list.length - ROW_LIMIT);
}
</script>

<style scoped src="../../styles/agent-result-card.css"></style>
