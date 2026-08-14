<!--
  AgentsTab — live view of every running "loop" in the system: the heartbeat,
  active agents + subagents, scheduled routines, and spawned jobs.

  Stage 1 (this file): read-only roster. Polls the main-process `agents:list`
  IPC every 3s (v1 — a push channel replaces polling in Stage 3). Click-through
  detail (live activity feed, kill/message controls) is Stage 2 — rows carry a
  `cursor-default` for now and detail is intentionally stubbed.
-->
<template>
  <div
    class="text-sm font-sans page-root h-full agents-page"
    :class="{ dark: isDark }"
  >
    <div class="flex flex-col h-full">
      <!-- Hero header -->
      <div class="overflow-hidden agents-header">
        <div class="py-12 sm:px-2 lg:relative lg:px-0 lg:py-16">
          <div class="mx-auto max-w-6xl px-4 md:px-6 lg:px-8">
            <div class="flex items-center justify-between gap-8">
              <div>
                <p class="inline bg-linear-to-r from-indigo-500 via-sky-500 to-indigo-500 dark:from-indigo-200 dark:via-sky-400 dark:to-indigo-200 bg-clip-text font-display text-5xl tracking-tight text-transparent">
                  Agents.
                </p>
                <p class="mt-3 text-2xl tracking-tight text-slate-500 dark:text-slate-400">
                  Everything running right now — agents, heartbeat, routines, jobs.
                </p>
              </div>

              <div class="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-500">
                <span
                  class="inline-block w-2 h-2 rounded-full"
                  :class="polling ? 'bg-emerald-400 animate-pulse' : 'bg-slate-400'"
                />
                <span>{{ polling ? 'Live · refreshes every 3s' : 'Paused' }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Body -->
      <div class="flex-1 overflow-auto">
        <div class="mx-auto max-w-6xl px-4 py-6 space-y-8">
          <!-- Loading state -->
          <div
            v-if="loading"
            class="flex items-center justify-center py-20 text-slate-500"
          >
            Loading agents...
          </div>

          <template v-else>
            <!-- ── Heartbeat ── -->
            <section>
              <h3 class="section-label">
                Heartbeat
              </h3>
              <div
                v-if="data.heartbeat"
                class="agents-card px-4 py-3 rounded-lg flex items-center gap-4"
              >
                <span
                  class="flex-shrink-0 inline-block w-2.5 h-2.5 rounded-full"
                  :class="heartbeatDot"
                />
                <div class="flex-1 min-w-0">
                  <p class="text-sm text-slate-800 dark:text-slate-200">
                    {{ data.heartbeat.isExecuting ? 'Executing a cycle' : data.heartbeat.schedulerRunning ? 'Idle — scheduler running' : 'Stopped' }}
                  </p>
                  <p class="text-xs text-slate-500 dark:text-slate-500 mt-0.5">
                    {{ data.heartbeat.totalTriggers }} triggers · {{ data.heartbeat.totalErrors }} errors · {{ data.heartbeat.totalSkips }} skips
                    <template v-if="data.heartbeat.lastTriggerMs">
                      · last {{ relTime(data.heartbeat.lastTriggerMs) }}
                    </template>
                  </p>
                </div>
                <span class="flex-shrink-0 text-xs text-slate-500 dark:text-slate-600">
                  up {{ formatDuration(data.heartbeat.uptimeMs) }}
                </span>
              </div>
              <p
                v-else
                class="text-sm text-slate-500 dark:text-slate-500 px-1"
              >
                Heartbeat is not initialized.
              </p>
            </section>

            <!-- ── Agents & subagents ── -->
            <section>
              <h3 class="section-label">
                Agents &amp; Subagents
                <span class="section-count">{{ data.agents.length }}</span>
              </h3>
              <div
                v-if="data.agents.length"
                class="space-y-1"
              >
                <div
                  v-for="agent in data.agents"
                  :key="agent.channel"
                  class="agents-row group flex items-center gap-3 px-4 py-3 rounded-lg"
                >
                  <span
                    class="flex-shrink-0 inline-block w-2.5 h-2.5 rounded-full"
                    :class="statusDot(agent.status)"
                  />
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-slate-800 dark:text-slate-200 truncate flex items-center gap-2">
                      {{ agent.name }}
                      <span
                        v-if="isSubconscious(agent.channel)"
                        class="badge"
                      >subconscious</span>
                      <span class="badge badge-type">{{ agent.type }}</span>
                    </p>
                    <p class="text-xs text-slate-500 dark:text-slate-500 truncate mt-0.5">
                      <span class="font-mono">{{ agent.channel }}</span>
                      <template v-if="agent.statusNote"> · {{ agent.statusNote }}</template>
                    </p>
                  </div>
                  <span class="flex-shrink-0 text-xs text-slate-500 dark:text-slate-600 text-right">
                    up {{ formatDuration(Date.now() - agent.startedAt) }}
                    <template v-if="idleMins(agent.lastActiveAt) >= 1">
                      <br>idle {{ idleMins(agent.lastActiveAt) }}m
                    </template>
                  </span>
                </div>
              </div>
              <p
                v-else
                class="text-sm text-slate-500 dark:text-slate-500 px-1"
              >
                No active agents.
              </p>
            </section>

            <!-- ── Routines ── -->
            <section>
              <h3 class="section-label">
                Routines
                <span class="section-count">{{ data.routines.length }}</span>
              </h3>
              <div
                v-if="data.routines.length"
                class="space-y-1"
              >
                <div
                  v-for="routine in data.routines"
                  :key="`${ routine.workflowId }:${ routine.nodeId }`"
                  class="agents-row flex items-center gap-3 px-4 py-3 rounded-lg"
                >
                  <span class="flex-shrink-0 inline-block w-2.5 h-2.5 rounded-full bg-purple-400" />
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-slate-800 dark:text-slate-200 truncate">
                      {{ routine.workflowName }}
                    </p>
                    <p class="text-xs text-slate-500 dark:text-slate-500 truncate mt-0.5 font-mono">
                      {{ routine.cronExpression }} · {{ routine.timezone }}
                    </p>
                  </div>
                  <span class="flex-shrink-0 text-xs text-slate-500 dark:text-slate-600">
                    <template v-if="routine.nextInvocation">next {{ formatTime(routine.nextInvocation) }}</template>
                    <template v-else>—</template>
                  </span>
                </div>
              </div>
              <p
                v-else
                class="text-sm text-slate-500 dark:text-slate-500 px-1"
              >
                No scheduled routines.
              </p>
            </section>

            <!-- ── Jobs ── -->
            <section>
              <h3 class="section-label">
                Jobs
                <span class="section-count">{{ data.jobs.length }}</span>
              </h3>
              <div
                v-if="data.jobs.length"
                class="space-y-1"
              >
                <div
                  v-for="job in data.jobs"
                  :key="job.jobId"
                  class="agents-row flex items-center gap-3 px-4 py-3 rounded-lg"
                >
                  <span
                    class="flex-shrink-0 inline-block w-2.5 h-2.5 rounded-full"
                    :class="jobDot(job.status)"
                  />
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-slate-800 dark:text-slate-200 truncate font-mono">
                      {{ job.jobId }}
                    </p>
                    <p class="text-xs text-slate-500 dark:text-slate-500 truncate mt-0.5">
                      {{ job.status }} · {{ job.taskCount }} task{{ job.taskCount === 1 ? '' : 's' }}
                      <template v-if="job.error"> · <span class="text-red-500 dark:text-red-400">{{ job.error }}</span></template>
                    </p>
                  </div>
                  <span class="flex-shrink-0 text-xs text-slate-500 dark:text-slate-600">
                    {{ relTime(job.createdAt) }}
                  </span>
                </div>
              </div>
              <p
                v-else
                class="text-sm text-slate-500 dark:text-slate-500 px-1"
              >
                No active jobs.
              </p>
            </section>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';

import { useTheme } from '@pkg/composables/useTheme';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { AgentsListResponse } from '@pkg/main/agentsIpc';

const POLL_MS = 3_000;

const { isDark } = useTheme();

const loading = ref(true);
const polling = ref(true);
const data = ref<AgentsListResponse>({
  agents: [], heartbeat: null, jobs: [], routines: [],
});

let pollTimer: ReturnType<typeof setInterval> | undefined;

// ── Data loading ──

async function loadAgents() {
  try {
    data.value = await ipcRenderer.invoke('agents:list' as any);
    polling.value = true;
  } catch {
    // Leave the last snapshot in place; flag that the refresh failed.
    polling.value = false;
  } finally {
    loading.value = false;
  }
}

// ── Formatting helpers ──

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0m';
  const mins = Math.floor(ms / 60_000);

  if (mins < 60) return `${ mins }m`;
  const hours = Math.floor(mins / 60);

  if (hours < 24) return `${ hours }h ${ mins % 60 }m`;

  return `${ Math.floor(hours / 24) }d ${ hours % 24 }h`;
}

function relTime(epochMs: number): string {
  const diff = Date.now() - epochMs;

  if (diff < 60_000) return 'just now';

  return `${ formatDuration(diff) } ago`;
}

function idleMins(lastActiveAt: number): number {
  return Math.floor((Date.now() - lastActiveAt) / 60_000);
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);

  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function isSubconscious(channel: string): boolean {
  return channel.startsWith('subconscious');
}

// ── Status dot colors ──

function statusDot(status: string): string {
  if (status === 'running') return 'bg-emerald-400';
  if (status === 'idle') return 'bg-amber-400';

  return 'bg-slate-500';
}

function jobDot(status: string): string {
  if (status === 'running') return 'bg-emerald-400';
  if (status === 'completed') return 'bg-sky-400';
  if (status === 'failed' || status === 'error') return 'bg-red-400';

  return 'bg-slate-500';
}

const heartbeatDot = computed(() => {
  const hb = data.value.heartbeat;

  if (!hb) return 'bg-slate-500';
  if (hb.isExecuting) return 'bg-emerald-400 animate-pulse';
  if (hb.schedulerRunning) return 'bg-amber-400';

  return 'bg-slate-500';
});

// ── Lifecycle ──

onMounted(() => {
  loadAgents();
  pollTimer = setInterval(loadAgents, POLL_MS);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.agents-page {
  background: var(--bg-page, #ffffff);
  color: var(--text-primary, #0d0d0d);
}

.agents-page.dark {
  background: var(--bg-page, #0f172a);
  color: var(--text-primary, #e0e0e0);
}

.agents-header {
  background: var(--bg-surface, #f8fafc);
}

.agents-page.dark .agents-header {
  background: #0f172a;
}

.section-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  margin-bottom: 0.75rem;
}

.section-count {
  font-size: 0.7rem;
  font-weight: 500;
  color: #94a3b8;
  background: rgba(100, 116, 139, 0.12);
  border-radius: 9999px;
  padding: 0 0.5rem;
  line-height: 1.25rem;
}

.agents-card,
.agents-row {
  background: transparent;
}

.agents-card {
  background: var(--bg-surface, rgba(0, 0, 0, 0.02));
}

.agents-page.dark .agents-card {
  background: rgba(255, 255, 255, 0.02);
}

.agents-row:hover {
  background: var(--bg-surface-hover, rgba(0, 0, 0, 0.04));
}

.agents-page.dark .agents-row:hover {
  background: rgba(255, 255, 255, 0.03);
}

.badge {
  display: inline-block;
  font-size: 0.625rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #7c8db5;
  background: rgba(124, 141, 181, 0.14);
  border-radius: 4px;
  padding: 0 0.35rem;
  line-height: 1rem;
}

.badge-type {
  color: #6aa9c4;
  background: rgba(106, 169, 196, 0.14);
}
</style>
