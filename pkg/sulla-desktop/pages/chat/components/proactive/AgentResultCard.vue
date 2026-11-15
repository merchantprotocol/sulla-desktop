<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  What a finished background agent did, shaped by what it was for (merge,
  QA run, review, fix, or anything else). Nothing consequential happens from
  here: buttons open things, copy text, or draft a message the user sends.
-->
<template>
  <article
    class="ar"
    :class="{ 'ar-group': items.length > 1 }"
    aria-label="Background agent result"
  >
    <header
      v-if="items.length > 1"
      class="ar-grouphead"
    >
      <b>{{ items.length }} agents finished</b><span>{{ groupSummary }}</span>
    </header>

    <section
      v-for="(item, index) in items"
      :key="`${item.jobId}:${item.taskIndex}`"
      class="ar-item"
      :class="{ 'ar-open': isOpen(index) }"
    >
      <div
        class="ar-head"
        :role="items.length > 1 ? 'button' : undefined"
        :tabindex="items.length > 1 ? 0 : undefined"
        :aria-expanded="items.length > 1 ? isOpen(index) : undefined"
        @click="items.length > 1 && toggle(index)"
        @keydown.enter.prevent="items.length > 1 && toggle(index)"
        @keydown.space.prevent="items.length > 1 && toggle(index)"
      >
        <span
          class="ar-chip"
          :class="`ar-${item.tone}`"
        ><span class="ar-dot" />{{ item.verdict }}</span>
        <span class="ar-title">
          <b>{{ item.label }}</b>
          <span>{{ byline(item) }}</span>
        </span>
        <span class="ar-kind">{{ PURPOSE_LABEL[item.purpose] }}</span>
        <span
          v-if="items.length > 1"
          class="ar-chev"
          aria-hidden="true"
        >⌄</span>
      </div>

      <template v-if="isOpen(index)">
        <p class="ar-outcome">
          {{ item.outcome }}
        </p>

        <div
          v-if="hasBody(item)"
          class="ar-body"
        >
          <!-- Merge and deploy -->
          <template v-if="item.merges?.length">
            <span class="ar-label">Merged</span>
            <div class="ar-rows">
              <div
                v-for="merge in shown(item.merges, index, 'merges')"
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
                v-if="hidden(item.merges, index, 'merges')"
                type="button"
                class="ar-more"
                @click="expand(index, 'merges')"
              >
                Show {{ hidden(item.merges, index, 'merges') }} more
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
          <template v-if="failedChecks(item).length">
            <span class="ar-label">Failed</span>
            <div class="ar-rows">
              <div
                v-for="check in failedChecks(item)"
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
                v-for="(finding, fi) in shown(item.findings, index, 'findings')"
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
                v-if="hidden(item.findings, index, 'findings')"
                type="button"
                class="ar-more"
                @click="expand(index, 'findings')"
              >
                Show {{ hidden(item.findings, index, 'findings') }} more
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

        <div class="ar-acts">
          <button
            v-for="link in (item.links ?? []).slice(0, 2)"
            :key="link.url"
            type="button"
            class="ar-btn"
            :title="link.url"
            @click="actions.openUrl(link.url)"
          >
            {{ link.label }}
          </button>
          <button
            v-if="item.threadId"
            type="button"
            class="ar-btn"
            @click="openAgent(item)"
          >
            Open agent
          </button>
          <button
            type="button"
            class="ar-btn ar-quiet"
            @click="copyReport(item)"
          >
            {{ copied === itemKey(item) ? 'Copied' : 'Copy report' }}
          </button>
          <span class="ar-sp" />
          <button
            v-if="item.next"
            type="button"
            class="ar-btn ar-pri"
            :title="`Puts this in the message box for you to send: ${item.next.prompt}`"
            @click="actions.draft(item.next.prompt)"
          >
            {{ item.next.label }}
          </button>
        </div>
        <p
          v-if="notice[itemKey(item)]"
          class="ar-notice"
          role="status"
        >
          {{ notice[itemKey(item)] }}
        </p>

        <details
          v-if="item.report"
          class="ar-raw"
        >
          <summary>Full report from the agent</summary>
          <pre>{{ item.report }}</pre>
        </details>
      </template>
    </section>
  </article>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';

import { useAgentResultActions } from '../../composables/useAgentResultActions';

import { PURPOSE_LABEL } from '@pkg/shared/agentResults/AgentResultCard';
import type { AgentResultCardData, AgentResultEnvironment, AgentResultFinding, AgentResultItem, AgentResultTone } from '@pkg/shared/agentResults/AgentResultCard';

const props = defineProps<{ data: AgentResultCardData }>();
const actions = useAgentResultActions();

const ENV_TONE: Record<AgentResultEnvironment['state'], AgentResultTone> = { deployed: 'ok', failed: 'bad', pending: 'info', held: 'dim' };
const ENV_LABEL: Record<AgentResultEnvironment['state'], string> = { deployed: 'Deployed', failed: 'Failed', pending: 'In progress', held: 'Not released' };
const SEVERITY_TONE: Record<AgentResultFinding['severity'], AgentResultTone> = { blocking: 'bad', major: 'warn', minor: 'dim' };
const ROW_LIMIT = 4;
const ATTENTION: AgentResultTone[] = ['bad', 'warn'];

const items = computed(() => props.data.items ?? []);
const open = reactive(new Set<number>(firstOpen()));
const more = reactive(new Set<string>());
const notice = reactive<Record<string, string>>({});
const copied = ref('');

const groupSummary = computed(() => {
  const attention = items.value.filter(item => ATTENTION.includes(item.tone)).length;
  const fine = items.value.length - attention;
  return [fine && `${ fine } done`, attention && `${ attention } need${ attention === 1 ? 's' : '' } you`].filter(Boolean).join(' · ');
});

/** One agent: always open. Several: open the first that needs attention, else the first. */
function firstOpen(): number[] {
  const list = props.data.items ?? [];
  if (list.length <= 1) return [0];
  const attention = list.findIndex(item => ATTENTION.includes(item.tone));
  return [attention >= 0 ? attention : 0];
}
function isOpen(index: number): boolean { return items.value.length === 1 || open.has(index) }
function toggle(index: number): void { if (open.has(index)) open.delete(index); else open.add(index); }
function itemKey(item: AgentResultItem): string { return `${ item.jobId }:${ item.taskIndex }` }

function shown<T>(list: T[], index: number, kind: string): T[] {
  return more.has(`${ index }:${ kind }`) ? list : list.slice(0, ROW_LIMIT);
}
function hidden(list: unknown[] | undefined, index: number, kind: string): number {
  return !list || more.has(`${ index }:${ kind }`) ? 0 : Math.max(0, list.length - ROW_LIMIT);
}
function expand(index: number, kind: string): void { more.add(`${ index }:${ kind }`) }

function failedChecks(item: AgentResultItem) { return (item.checks ?? []).filter(check => !check.passed) }
function hasBody(item: AgentResultItem): boolean {
  return !!(item.merges?.length || item.environments?.length || item.tally || failedChecks(item).length || item.findings?.length || item.change);
}

function byline(item: AgentResultItem): string {
  return [item.agentId, item.durationMs ? duration(item.durationMs) : ''].filter(Boolean).join(' · ');
}
function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${ Math.max(1, Math.round(ms / 1000)) }s`;
  if (minutes < 60) return `${ minutes }m`;
  return `${ Math.floor(minutes / 60) }h ${ minutes % 60 }m`;
}

function openAgent(item: AgentResultItem): void {
  if (!actions.openAgent(item)) flash(item, 'Could not open this agent\'s conversation here.');
}
async function copyReport(item: AgentResultItem): Promise<void> {
  if (!await actions.copy(item.report)) { flash(item, 'Could not copy the report.'); return }
  copied.value = itemKey(item);
  setTimeout(() => { if (copied.value === itemKey(item)) copied.value = ''; }, 2000);
}
function flash(item: AgentResultItem, text: string): void {
  const key = itemKey(item);
  notice[key] = text;
  setTimeout(() => { if (notice[key] === text) delete notice[key]; }, 4000);
}
</script>

<style scoped>
/*
 * Same layer as the activity tray: the page colour, neutral ink mixed from
 * --text-primary (theme text tokens can share the surface hue), and colour
 * kept for state.
 */
.ar {
  --ar-ink-2: color-mix(in srgb, var(--text-primary) 78%, var(--bg-surface));
  --ar-ink-3: color-mix(in srgb, var(--text-primary) 58%, var(--bg-surface));
  --ar-raised: color-mix(in srgb, var(--bg-surface) 55%, var(--bg-page));
  container-type: inline-size;
  border: 1px solid var(--border-strong); border-radius: 12px; background: var(--bg-page);
  color: var(--text-primary); font-family: var(--font-body); overflow: hidden;
}
.ar-grouphead { display: flex; align-items: center; gap: 10px; padding: 11px 16px; border-bottom: 1px solid var(--border-default); font-size: 13px; color: var(--ar-ink-2); }
.ar-grouphead b { color: var(--text-primary); font-weight: 650; }
.ar-group .ar-item + .ar-item { border-top: 1px solid var(--border-default); }

.ar-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 12px 16px 0; }
.ar-group .ar-head { grid-template-columns: auto minmax(0, 1fr) auto auto; padding: 10px 16px; cursor: pointer; }
.ar-group .ar-head:hover, .ar-group .ar-open > .ar-head { background: var(--ar-raised); }
.ar-group .ar-open { background: var(--ar-raised); }
.ar-head:focus-visible, .ar-btn:focus-visible, .ar-more:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ar-chev { color: var(--ar-ink-3); transition: transform .18s cubic-bezier(.22,1,.36,1); }
.ar-open .ar-chev { transform: rotate(180deg); }

.ar-chip {
  display: inline-flex; align-items: center; gap: 6px; justify-self: start; height: 22px; padding: 0 8px; border-radius: 6px;
  font-size: 11px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap;
}
.ar-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.ar-ok { background: color-mix(in srgb, var(--status-success) 16%, transparent); color: var(--status-success); }
.ar-warn { background: color-mix(in srgb, var(--status-warning) 16%, transparent); color: var(--status-warning); }
.ar-bad { background: color-mix(in srgb, var(--status-error) 16%, transparent); color: var(--status-error); }
.ar-info { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
.ar-dim { background: color-mix(in srgb, var(--text-primary) 8%, transparent); color: var(--ar-ink-2); }
.ar-ok-t { color: var(--status-success); }
.ar-bad-t { color: var(--status-error); }

.ar-title { min-width: 0; }
.ar-title b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 650; }
.ar-title span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--ar-ink-3); }
.ar-kind { font-size: 12px; color: var(--ar-ink-3); white-space: nowrap; }
.ar-outcome { max-width: 68ch; margin: 10px 16px 0; font-size: 15px; line-height: 1.5; }
.ar-body { margin: 12px 16px 0; }
.ar-label { display: block; margin: 12px 0 4px; font-size: 12px; color: var(--ar-ink-3); }
.ar-label:first-child { margin-top: 0; }
.ar-rows { border-top: 1px solid var(--border-default); }
.ar-row { display: grid; gap: 12px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--border-default); font-size: 13px; }
.ar-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ar-ink-2); }
.ar-t b { color: var(--text-primary); font-weight: 600; }
.ar-r-merge { grid-template-columns: 64px minmax(0, 1fr) auto; }
.ar-r-env { grid-template-columns: 110px minmax(0, 1fr) auto; }
.ar-r-check { grid-template-columns: 16px minmax(0, 1fr); }
.ar-r-find { grid-template-columns: 84px minmax(0, 1fr); }
.ar-r-file { grid-template-columns: minmax(0, 1fr); }
.ar-ico { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.ar-mono, .ar-file { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; color: var(--text-primary); }
.ar-sha { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; padding: 1px 5px; border-radius: 4px; background: color-mix(in srgb, var(--text-primary) 8%, transparent); }
.ar-tally { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 4px; font-size: 13px; color: var(--ar-ink-2); }
.ar-tally b { color: var(--text-primary); font-weight: 650; }
.ar-tally .ar-ok-t { color: var(--status-success); }
.ar-tally .ar-bad-t { color: var(--status-error); }
.ar-more { margin-top: 6px; padding: 0; border: 0; background: none; color: var(--accent); font: inherit; font-size: 12.5px; cursor: pointer; }

.ar-acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 16px 14px; }
.ar-btn {
  height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--border-strong); background: transparent;
  color: var(--text-primary); font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer;
}
.ar-btn:hover { border-color: var(--accent); }
.ar-btn.ar-quiet { border-color: transparent; color: var(--ar-ink-2); }
.ar-btn.ar-quiet:hover { color: var(--text-primary); }
.ar-btn.ar-pri { background: var(--accent); border-color: var(--accent); color: var(--bg-page); font-weight: 650; }
.ar-sp { flex: 1; }
.ar-notice { margin: -6px 16px 12px; font-size: 12px; color: var(--ar-ink-2); }

.ar-raw { margin: 0 16px; border-top: 1px solid var(--border-default); }
.ar-raw summary { cursor: pointer; padding: 9px 0; font-size: 12.5px; color: var(--ar-ink-2); }
.ar-raw pre {
  max-height: 320px; overflow: auto; margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; background: var(--ar-raised);
  color: var(--ar-ink-2); font: 12px/1.55 var(--font-mono, ui-monospace, monospace); white-space: pre-wrap; overflow-wrap: anywhere;
}

@container (max-width: 520px) {
  .ar-head, .ar-group .ar-head { grid-template-columns: minmax(0, 1fr) auto; }
  .ar-head > .ar-chip { grid-column: 1 / -1; }
  .ar-kind { display: none; }
  .ar-r-env { grid-template-columns: minmax(0, 1fr) auto; }
  .ar-r-env > :first-child { grid-column: 1 / -1; }
  .ar-r-find { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) { .ar-chev { transition: none; } }
</style>
