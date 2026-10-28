<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="wf-list">
    <!-- Filter bar: search + Status / Runs on / Trigger -->
    <div class="wf-filters">
      <label class="wf-find">
        <WfIcon
          name="search"
          class="wf-find-ico"
        />
        <input
          v-model="query"
          type="text"
          placeholder="Search workflows"
          aria-label="Search workflows"
        >
      </label>
      <label
        class="wf-sel"
        :class="{ on: statusFilter !== 'any' }"
      >
        <span>Status</span> {{ statusOptions.find(o => o.value === statusFilter)?.label }}
        <select
          v-model="statusFilter"
          aria-label="Status"
        >
          <option
            v-for="o in statusOptions"
            :key="o.value"
            :value="o.value"
          >{{ o.label }} ({{ o.count }})</option>
        </select>
      </label>
      <label
        class="wf-sel"
        :class="{ on: locationFilter !== 'any' }"
      >
        <span>Runs on</span> {{ locationOptions.find(o => o.value === locationFilter)?.label }}
        <select
          v-model="locationFilter"
          aria-label="Runs on"
        >
          <option
            v-for="o in locationOptions"
            :key="o.value"
            :value="o.value"
          >{{ o.label }}</option>
        </select>
      </label>
      <label
        class="wf-sel"
        :class="{ on: triggerFilter !== 'any' }"
      >
        <span>Trigger</span> {{ triggerOptions.find(o => o.value === triggerFilter)?.label }}
        <select
          v-model="triggerFilter"
          aria-label="Trigger"
        >
          <option
            v-for="o in triggerOptions"
            :key="o.value"
            :value="o.value"
          >{{ o.label }}</option>
        </select>
      </label>
      <button
        v-if="filtersActive"
        type="button"
        class="wf-clear"
        @click="clearFilters"
      >
        Clear
      </button>
    </div>

    <div class="wf-card">
      <table class="wf-tbl">
        <thead>
          <tr>
            <th>Workflow</th>
            <th>Status</th>
            <th>Last run</th>
            <th>Last 12</th>
            <th>Next run</th>
            <th>Runs on</th>
            <th>Trigger</th>
            <th class="wf-act-col" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.id"
            class="wf-row"
            @click="$emit('open', row.id)"
          >
            <td>
              <div class="wf-name">
                <span class="wf-fi"><WfIcon name="workflow" /></span>
                <div class="wf-t">
                  <b>
                    {{ row.name }}
                    <span
                      v-if="row.system"
                      class="wf-core"
                      title="Core workflow — ships with Sulla Desktop. You can disable it, but not edit or delete it."
                    >Core</span>
                  </b>
                  <small>{{ row.description || '—' }}</small>
                </div>
              </div>
            </td>
            <td>
              <span
                class="wf-pill"
                :class="row.pill.cls"
              >{{ row.pill.label }}</span>
            </td>
            <td>
              <button
                v-if="row.last"
                type="button"
                class="wf-res"
                :title="row.last.outcome === 'running' ? 'Watch this run' : 'Open this run'"
                @click.stop="openLast(row.id, row.last)"
              >
                <i
                  class="wf-dot"
                  :class="row.last.outcome"
                />
                <span>
                  <b>{{ OUTCOME_LABEL[row.last.outcome] }}</b>
                  <small>{{ row.last.outcome === 'running' ? 'Running now' : formatWhen(row.last.startedAt, now) }} · {{ formatDuration(durationMs(row.last.startedAt, row.last.completedAt, now.getTime())) }}</small>
                </span>
              </button>
              <span
                v-else
                class="wf-muted"
              >Never run</span>
            </td>
            <td>
              <span
                v-if="row.spark.length"
                class="wf-spark"
              >
                <i
                  v-for="bar in row.spark"
                  :key="bar.executionId"
                  :class="bar.outcome"
                  :style="{ height: `${ bar.height }px` }"
                  :title="bar.title"
                />
              </span>
              <span
                v-else
                class="wf-muted"
              >—</span>
            </td>
            <td :class="row.nextWarn ? 'wf-warn' : 'wf-muted'">
              {{ row.next }}
            </td>
            <td>
              <WorkflowLocTag
                :location="row.location"
                :device-name="deviceName"
              />
            </td>
            <td>
              <span class="wf-src"><WfIcon :name="row.trigger.kind" />{{ row.trigger.label }}</span>
            </td>
            <td @click.stop>
              <div
                class="wf-actions"
                :class="{ open: menuFor === row.id }"
              >
                <button
                  v-if="row.status === 'archive'"
                  type="button"
                  class="wf-btn sm"
                  @click="$emit('restore', row.id)"
                >
                  Restore
                </button>
                <button
                  v-else-if="row.status === 'draft'"
                  type="button"
                  class="wf-btn sm"
                  @click="$emit('edit', row.id)"
                >
                  Edit
                </button>
                <button
                  v-else
                  type="button"
                  class="wf-btn sm"
                  :disabled="row.last?.outcome === 'running' || running.has(row.id)"
                  @click="$emit('run', row.id)"
                >
                  <WfIcon
                    name="play"
                    class="wf-bi"
                  />Run
                </button>
                <div class="wf-menu-wrap">
                  <button
                    type="button"
                    class="wf-btn ico"
                    :aria-label="`More actions for ${ row.name }`"
                    title="More"
                    @click="toggleMenu(row.id)"
                  >
                    <WfIcon name="more" />
                  </button>
                  <div
                    v-if="menuFor === row.id"
                    class="wf-menu"
                    role="menu"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      @click="act('edit', row.id)"
                    >
                      Open in editor
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      @click="act('duplicate', row.id)"
                    >
                      Duplicate
                    </button>
                    <button
                      v-if="!row.system"
                      type="button"
                      role="menuitem"
                      @click="act('archive', row.id)"
                    >
                      {{ row.status === 'archive' ? 'Unarchive' : 'Archive' }}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      @click="act('export', row.id)"
                    >
                      Export…
                    </button>
                    <button
                      v-if="!row.system"
                      type="button"
                      role="menuitem"
                      @click="act('publish', row.id)"
                    >
                      Publish to Marketplace…
                    </button>
                    <button
                      v-if="!row.system"
                      type="button"
                      role="menuitem"
                      class="danger"
                      @click="act('delete', row.id)"
                    >
                      Delete…
                    </button>
                  </div>
                </div>
              </div>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td
              colspan="8"
              class="wf-empty"
            >
              No workflows match these filters.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="wf-legend">
      <span><i class="wf-dot ok" />succeeded</span>
      <span><i class="wf-dot failed" />failed</span>
      <span><i class="wf-dot running" />running</span>
      <span><i class="wf-dot stopped" />stopped</span>
      <span>Bar height = run duration</span>
      <span><WorkflowLocTag
        location="desktop"
        :device-name="deviceName"
      /> runs on this device only</span>
      <span><WorkflowLocTag
        location="server"
        :device-name="deviceName"
      /> runs on your Sulla server</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

import WfIcon from '@pkg/components/routines/WfIcon.vue';
import WorkflowLocTag from '@pkg/components/routines/WorkflowLocTag.vue';
import {
  OUTCOME_LABEL, durationMs, formatDuration, formatNext, formatWhen,
} from '@pkg/components/routines/runFormat';
import type { RunSummary, WorkflowRunInfo } from '@pkg/main/workflowRunSummaries';
import type { RoutineSummary } from '@pkg/types/routines';

type MenuAction = 'edit' | 'duplicate' | 'archive' | 'export' | 'publish' | 'delete';

const props = defineProps<{
  routines:   RoutineSummary[];
  summaries:  Record<string, WorkflowRunInfo>;
  deviceName: string;
  /** Ids with a Run click in flight, so the button can't double-fire. */
  running:    Set<string>;
  now:        Date;
}>();

const emit = defineEmits<{
  (e: 'open', id: string): void;
  (e: 'open-run', id: string, executionId: string): void;
  (e: 'run', id: string): void;
  (e: 'restore', id: string): void;
  (e: MenuAction, id: string): void;
}>();

const query = ref('');
const statusFilter = ref<'any' | 'active' | 'paused' | 'draft' | 'failing' | 'archive'>('any');
const locationFilter = ref<'any' | 'desktop' | 'server'>('any');
const triggerFilter = ref('any');

function pillFor(r: RoutineSummary, info?: WorkflowRunInfo) {
  if (r.status === 'archive') return { key: 'archive', label: 'Archived', cls: 'idle' };
  if (r.status === 'draft') return { key: 'draft', label: 'Draft', cls: 'acc' };
  if (info && !info.enabled) return { key: 'paused', label: 'Paused', cls: 'idle' };

  return { key: 'active', label: 'Active', cls: 'ok' };
}

// Bars are the last 12 runs oldest → newest; height encodes duration
// relative to the slowest of the twelve.
function sparkFor(runs: RunSummary[], now: number) {
  const ordered = [...runs].reverse();
  const durations = ordered.map(run => durationMs(run.startedAt, run.completedAt, now) ?? 0);
  const longest = Math.max(1, ...durations);

  return ordered.map((run, i) => ({
    executionId: run.executionId,
    outcome:     run.outcome,
    height:      Math.round(5 + 11 * (durations[i] / longest)),
    title:       `${ OUTCOME_LABEL[run.outcome] } · ${ formatWhen(run.startedAt) } · ${ formatDuration(durations[i]) } · ${ run.trigger }`,
  }));
}

const enriched = computed(() => props.routines.map((r) => {
  const info = props.summaries[r.id];
  const pill = pillFor(r, info);
  const runs = info?.runs ?? [];
  let next = '—';
  let nextWarn = false;
  if (pill.key === 'paused') {
    next = 'Paused';
  } else if (pill.key === 'active' && info) {
    if (info.nextRunAt) {
      next = formatNext(info.nextRunAt, props.now);
    } else if (info.nextRunOn) {
      next = info.nextRunOn;
    } else if (info.trigger.kind === 'schedule') {
      next = 'Not armed';
      nextWarn = true;
    }
  }

  return {
    id:          r.id,
    name:        r.name,
    description: r.description,
    system:      r.system === true,
    status:      r.status,
    pill,
    last:        runs[0] ?? null,
    spark:       sparkFor(runs, props.now.getTime()),
    next,
    nextWarn,
    location:    info?.location ?? 'desktop',
    trigger:     info?.trigger ?? { kind: 'none', label: '—' },
  };
}));

const rows = computed(() => {
  const q = query.value.trim().toLowerCase();

  return enriched.value.filter((row) => {
    if (q && !`${ row.name } ${ row.description }`.toLowerCase().includes(q)) return false;
    if (statusFilter.value === 'any' && row.pill.key === 'archive') return false;
    if (statusFilter.value === 'failing' && row.last?.outcome !== 'failed') return false;
    if (!['any', 'failing'].includes(statusFilter.value) && row.pill.key !== statusFilter.value) return false;
    if (locationFilter.value !== 'any' && row.location !== locationFilter.value) return false;
    if (triggerFilter.value !== 'any' && row.trigger.kind !== triggerFilter.value) return false;

    return true;
  });
});

const statusOptions = computed(() => {
  const all = enriched.value;
  const count = (key: string) => all.filter(r => r.pill.key === key).length;

  return [
    { value: 'any', label: 'Any', count: all.length - count('archive') },
    { value: 'active', label: 'Active', count: count('active') },
    { value: 'failing', label: 'Failing', count: all.filter(r => r.pill.key !== 'archive' && r.last?.outcome === 'failed').length },
    { value: 'paused', label: 'Paused', count: count('paused') },
    { value: 'draft', label: 'Draft', count: count('draft') },
    { value: 'archive', label: 'Archived', count: count('archive') },
  ];
});

const locationOptions = computed(() => [
  { value: 'any', label: 'Anywhere' },
  { value: 'desktop', label: props.deviceName || 'This device' },
  { value: 'server', label: 'Server' },
]);

const TRIGGER_LABELS: Record<string, string> = {
  schedule: 'Schedule', manual: 'Manual', chat: 'Chat', calendar: 'Calendar', heartbeat: 'Heartbeat', none: 'No trigger',
};
const triggerOptions = computed(() => {
  const kinds = [...new Set(enriched.value.map(r => r.trigger.kind))].filter(k => TRIGGER_LABELS[k]);

  return [{ value: 'any', label: 'Any' }, ...kinds.map(k => ({ value: k, label: TRIGGER_LABELS[k] }))];
});

const filtersActive = computed(() => !!query.value || statusFilter.value !== 'any' || locationFilter.value !== 'any' || triggerFilter.value !== 'any');

// A running run opens the live canvas; finished ones open as a past run.
function openLast(id: string, last: RunSummary | null) {
  if (!last || last.outcome === 'running') emit('open', id);
  else emit('open-run', id, last.executionId);
}

function clearFilters() {
  query.value = '';
  statusFilter.value = 'any';
  locationFilter.value = 'any';
  triggerFilter.value = 'any';
}

// Row "More" menu: one open at a time, closes on any outside click.
const menuFor = ref<string | null>(null);

function closeMenu() {
  menuFor.value = null;
  document.removeEventListener('click', closeMenu);
}

function toggleMenu(id: string) {
  if (menuFor.value === id) {
    closeMenu();

    return;
  }
  menuFor.value = id;
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}

function act(action: MenuAction, id: string) {
  closeMenu();
  emit(action as any, id);
}

onBeforeUnmount(() => document.removeEventListener('click', closeMenu));
</script>

<style scoped lang="scss">
// Colours come from the app theme tokens so every theme (light included)
// renders this list correctly.
.wf-list {
  --wf-line: var(--border-subtle);
  --wf-line-2: var(--border-default);
  --wf-ok: var(--status-success);
  --wf-bad: var(--status-error);
  --wf-warn: var(--text-warning);
  --wf-acc: var(--accent-primary);

  margin-top: 28px;
  font-family: var(--sans);
  font-size: 12.5px;
  color: var(--text-primary);
}

.wf-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.wf-find {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  max-width: 420px;
  min-width: 180px;
  padding: 5px 10px;
  border: 1px solid var(--wf-line-2);
  border-radius: 9px;
  background: var(--bg-surface);
  color: var(--text-muted);

  input {
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0 !important;
    outline: 0;
    background: transparent !important;
    color: var(--text-primary);
    font: inherit;
    box-shadow: none;
  }
}
.wf-find-ico { width: 14px; height: 14px; flex: none; }

.wf-sel {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--wf-line-2);
  border-radius: 8px;
  background: var(--bg-surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  cursor: pointer;

  > span { color: var(--text-muted); font-weight: 400; }
  &::after {
    content: "";
    width: 6px;
    height: 6px;
    border-right: 1.5px solid var(--text-muted);
    border-bottom: 1.5px solid var(--text-muted);
    transform: rotate(45deg) translateY(-2px);
  }
  select {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  &.on {
    border-color: var(--border-accent);
    background: var(--bg-accent);
    color: var(--text-accent);
  }
}

.wf-clear {
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 7px;
  cursor: pointer;
  &:hover { color: var(--text-primary); }
}

.wf-card {
  background: var(--bg-surface);
  border: 1px solid var(--wf-line);
  border-radius: 12px;
  box-shadow: var(--shadow-sm);
}

.wf-tbl {
  width: 100%;
  border-collapse: collapse;

  th {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: .07em;
    color: var(--text-muted);
    font-weight: 600;
    text-align: left;
    padding: 9px 12px;
    border-bottom: 1px solid var(--wf-line);
    white-space: nowrap;
  }
  td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--wf-line);
    vertical-align: middle;
  }
  tbody tr:last-child td { border-bottom: 0; }
  th:first-child, td:first-child { padding-left: 16px; }
  th:last-child, td:last-child { padding-right: 14px; }
  .wf-act-col { width: 120px; }
}

.wf-row {
  cursor: pointer;
  &:hover td { background: var(--bg-surface-hover); }
  &:hover .wf-actions { opacity: 1; }
}

.wf-name {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.wf-t {
  min-width: 0;
  max-width: 280px;

  b {
    display: block;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  small {
    display: block;
    color: var(--text-muted);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
.wf-fi {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  flex: none;
  background: var(--bg-accent);
  color: var(--text-accent);

  svg { width: 17px; height: 17px; }
}
.wf-core {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  border: 1px solid var(--wf-line-2);
}

.wf-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;

  &.ok { background: var(--bg-success); color: var(--text-success); }
  &.idle { background: var(--bg-surface-alt); color: var(--text-secondary); }
  &.acc { background: var(--bg-accent); color: var(--text-accent); }
}

.wf-res {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
  padding: 0;
  margin: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;

  b { display: block; font-weight: 550; font-size: 12px; }
  small { display: block; color: var(--text-muted); font-size: 11px; }
  &:hover b { color: var(--text-accent); }
}

.wf-dot {
  display: inline-block;
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--text-muted);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--text-muted) 16%, transparent);

  &.ok { background: var(--wf-ok); box-shadow: 0 0 0 3px var(--bg-success); }
  &.failed { background: var(--wf-bad); box-shadow: 0 0 0 3px var(--bg-error); }
  &.running { background: var(--wf-acc); box-shadow: 0 0 0 3px var(--bg-accent); }
}

.wf-spark {
  display: flex;
  gap: 2px;
  align-items: flex-end;
  height: 16px;

  i {
    width: 4px;
    border-radius: 1px;
    background: var(--wf-ok);
    opacity: .8;
    &.failed { background: var(--wf-bad); }
    &.running { background: var(--wf-acc); }
    &.stopped { background: var(--text-muted); }
  }
}

.wf-muted { color: var(--text-muted); white-space: nowrap; }
.wf-warn { color: var(--wf-warn); white-space: nowrap; }

.wf-src {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  white-space: nowrap;
  font-size: 12px;

  svg { width: 14px; height: 14px; flex: none; }
}

.wf-actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
  opacity: 0;
  transition: opacity .12s;
  &.open { opacity: 1; }
}

.wf-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  border-radius: 6px;
  border: 1px solid var(--wf-line-2);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;

  &.sm { padding: 3px 8px; font-size: 11.5px; line-height: 1.45; }
  &.ico {
    width: 26px;
    height: 26px;
    padding: 4px;
    justify-content: center;
    border-color: transparent;
    background: transparent;
    color: var(--text-muted);
    svg { width: 14px; height: 14px; }
    &:hover { background: var(--bg-surface-hover); color: var(--text-primary); }
  }
  &.sm:hover:not(:disabled) { border-color: var(--border-accent); color: var(--text-accent); }
  &:disabled { opacity: .5; cursor: default; }
}
.wf-bi { width: 12px; height: 12px; }

.wf-menu-wrap { position: relative; }
.wf-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  min-width: 200px;
  padding: 4px;
  border: 1px solid var(--wf-line-2);
  border-radius: 10px;
  background: var(--bg-surface);
  box-shadow: var(--shadow-md);

  button {
    display: block;
    width: 100%;
    margin: 0;
    padding: 7px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-primary);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    &:hover { background: var(--bg-surface-hover); }
    &.danger { color: var(--text-error); }
  }
}

.wf-empty {
  padding: 28px 16px !important;
  text-align: center;
  color: var(--text-muted);
}

.wf-legend {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  padding: 12px 4px 0;
  color: var(--text-muted);
  font-size: 11.5px;

  > span { display: inline-flex; align-items: center; gap: 6px; }
}
</style>
