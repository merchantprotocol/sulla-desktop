<!--
  AgentsTab — live view of every running "loop" in the system: the heartbeat,
  active agents + subagents, scheduled routines, and spawned jobs.

  Read-only roster. Polls the main-process `agents:list` IPC every 3s (v1 — a
  push channel replaces polling in Stage 3). Clicking an agent opens its
  stored conversations (AgentConversations). Kill/message controls are not
  built yet.
-->
<template>
  <div
    class="text-sm font-sans page-root h-full agents-page"
    :class="{ dark: isDark }"
  >
    <div class="flex flex-col h-full">
      <!-- Hero header -->
      <div
        v-if="!selectedAgent"
        class="overflow-hidden agents-header"
      >
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

      <!-- Agent detail: stored conversations -->
      <div
        v-if="selectedAgent"
        class="flex-1 min-h-0"
      >
        <AgentConversations
          :channel="selectedAgent.channel"
          :agent-name="selectedAgent.name"
          :tick="pollTick"
          @close="selectedAgent = null"
        />
      </div>

      <!-- Body -->
      <div
        v-else
        class="flex-1 overflow-auto"
      >
        <div class="mx-auto max-w-6xl px-4 py-6 space-y-8">
          <section>
            <div class="flex items-center justify-between mb-3">
              <h3 class="section-label !mb-0">
                Custom agents <span class="section-count">{{ definitions.length }}</span>
              </h3>
              <div class="flex gap-2">
                <input
                  ref="manifestInput"
                  class="hidden"
                  type="file"
                  accept="application/json,.json"
                  @change="importManifest"
                >
                <button
                  class="agent-link"
                  type="button"
                  @click="manifestInput?.click()"
                >
                  Import manifest
                </button>
                <button
                  class="agent-action"
                  type="button"
                  @click="openCreate"
                >
                  New agent
                </button>
              </div>
            </div>
            <div class="agents-card rounded-lg overflow-hidden">
              <div
                v-if="!definitions.length"
                class="px-4 py-5 text-slate-500"
              >
                No custom agents yet.
              </div>
              <div
                v-for="agent in definitions"
                :key="agent.id"
                class="agents-row flex items-center gap-4 px-4 py-3 border-b border-slate-200/10"
              >
                <div
                  class="agent-avatar-tile"
                  aria-hidden="true"
                >
                  {{ agent.name.slice(0, 1).toUpperCase() }}
                </div>
                <div class="flex-1 min-w-0">
                  <p class="text-sm text-slate-800 dark:text-slate-200 truncate">
                    {{ agent.name }}
                  </p>
                  <p class="text-xs text-slate-500 truncate">
                    {{ agent.description || 'No description' }}
                  </p>
                </div>
                <span class="text-xs font-mono text-slate-500">{{ agent.model || 'default model' }}</span>
                <span class="badge">{{ agent.sourceKind === 'marketplace' ? `Marketplace ${agent.marketplaceVersion || ''}` : 'Local' }}</span>
                <button
                  class="agent-link"
                  type="button"
                  @click="exportManifest(agent)"
                >
                  Export
                </button>
                <button
                  class="agent-link"
                  type="button"
                  @click="openEdit(agent)"
                >
                  Edit
                </button>
                <button
                  class="agent-link text-red-400"
                  type="button"
                  @click="removeDefinition(agent)"
                >
                  Delete
                </button>
              </div>
            </div>
          </section>

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
                  class="agents-row group flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer"
                  role="button"
                  tabindex="0"
                  :title="`View ${agent.name} conversations`"
                  @click="openAgent(agent)"
                  @keydown.enter="openAgent(agent)"
                >
                  <div
                    class="agent-avatar-tile agent-avatar-live"
                    aria-hidden="true"
                  >
                    {{ agent.name.slice(0, 1).toUpperCase() }}
                    <span
                      class="agent-live-dot"
                      :class="[statusDot(agent.status), { 'agent-live-dot-running': agent.status === 'running' }]"
                    />
                  </div>
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
                      <template v-if="agent.statusNote">
                        · {{ agent.statusNote }}
                      </template>
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
                  :key="`${routine.workflowId}:${routine.nodeId}`"
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
                      <template v-if="job.error">
                        · <span class="text-red-500 dark:text-red-400">{{ job.error }}</span>
                      </template>
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

    <div
      v-if="editing"
      class="agent-modal-backdrop"
      @click.self="editing = null"
    >
      <form
        class="agent-modal"
        @submit.prevent="saveDefinition"
      >
        <aside
          class="agent-modal-nav"
          aria-hidden="true"
        >
          <p class="agent-modal-kicker">
            AGENT STUDIO
          </p>
          <h2>{{ editing.id ? 'Edit agent' : 'Create agent' }}</h2>
          <p>Shape how this agent introduces itself, thinks, and responds.</p>
          <div class="agent-modal-nav-item agent-modal-nav-current">
            <span>01</span>Identity
          </div>
          <div class="agent-modal-nav-item">
            <span>02</span>Model
          </div>
          <div class="agent-modal-nav-item">
            <span>03</span>Instructions
          </div>
          <div class="agent-modal-nav-state">
            <span /> Draft configuration
          </div>
        </aside>
        <div class="agent-modal-content">
          <h2 class="agent-modal-legacy-title text-xl text-slate-100">
            {{ editing.id ? 'Edit agent' : 'Create agent' }}
          </h2>
          <div class="agent-modal-heading">
            <p>AGENT PROFILE</p>
            <h3>Give this agent a clear point of view.</h3>
            <span>Identity, model, and instructions stay exactly where you save them today.</span>
          </div>
          <label>Name<input
            v-model="editing.name"
            required
          ></label>
          <label v-if="!editing.id">Slug<input
            v-model="editing.slug"
            required
            pattern="[a-z0-9][a-z0-9-]*"
          ></label>
          <label>Description<input v-model="editing.description"></label>
          <label>Model
            <select
              v-model="editing.modelKey"
              required
            >
              <option
                v-for="model in availableModels"
                :key="`${model.providerId}:${model.modelId}`"
                :value="`${model.providerId}:${model.modelId}`"
              >{{ model.providerName }} · {{ model.label }}</option>
            </select>
          </label>
          <label>Prompt<textarea
            v-model="editing.prompt"
            required
            rows="12"
          /></label>
          <div class="agent-modal-actions flex justify-end gap-2">
            <button
              class="agent-link"
              type="button"
              @click="editing = null"
            >
              Cancel
            </button>
            <button
              class="agent-action"
              type="submit"
              :disabled="saving"
            >
              {{ saving ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';

import { useTheme } from '@pkg/composables/useTheme';
import type { AgentDefinitionResponse, AgentsListResponse } from '@pkg/main/agentsIpc';
import AgentConversations from '@pkg/pages/agents/AgentConversations.vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const POLL_MS = 3_000;

const { isDark } = useTheme();

const loading = ref(true);
const polling = ref(true);
const data = ref<AgentsListResponse>({
  agents: [], heartbeat: null, jobs: [], routines: [],
});
const definitions = ref<AgentDefinitionResponse[]>([]);
const availableModels = ref<{ providerId: string; providerName: string; modelId: string; label: string }[]>([]);
const saving = ref(false);
const manifestInput = ref<HTMLInputElement | null>(null);
const editing = ref<null | { id?: string; slug: string; name: string; description: string; modelKey: string; prompt: string }>(null);

const selectedAgent = ref<{ channel: string; name: string } | null>(null);
// Bumped every poll so the open conversation view refreshes on the same beat.
const pollTick = ref(0);

let pollTimer: ReturnType<typeof setInterval> | undefined;

function openAgent(agent: AgentsListResponse['agents'][number]) {
  selectedAgent.value = { channel: agent.channel, name: agent.name };
}

// ── Data loading ──

async function loadAgents() {
  pollTick.value++;
  // The roster isn't visible while an agent's conversations are open.
  if (selectedAgent.value) return;
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

async function loadDefinitions() {
  definitions.value = await ipcRenderer.invoke('agent-definitions:list');
}

async function loadModels() {
  const providers = await ipcRenderer.invoke('model-provider:get-providers');
  const groups = await Promise.all(providers.filter(p => p.connected !== false).map(async provider => ({
    provider,
    models: await ipcRenderer.invoke('model-provider:get-models', provider.id),
  })));
  availableModels.value = groups.flatMap(({ provider, models }) => models.map(model => ({
    providerId: provider.id, providerName: provider.name, modelId: model.id, label: model.name,
  })));
}

function openCreate() {
  const first = availableModels.value[0];
  editing.value = { slug: '', name: '', description: '', modelKey: first ? `${ first.providerId }:${ first.modelId }` : '', prompt: '' };
}

function openEdit(agent: AgentDefinitionResponse) {
  editing.value = {
    id:          agent.id,
    slug:        agent.slug,
    name:        agent.name,
    description: agent.description,
    modelKey:    agent.provider && agent.model ? `${ agent.provider }:${ agent.model }` : '',
    prompt:      agent.prompt,
  };
}

async function saveDefinition() {
  if (!editing.value) return;
  saving.value = true;
  try {
    const split = editing.value.modelKey.indexOf(':');
    const provider = split >= 0 ? editing.value.modelKey.slice(0, split) : '';
    const model = split >= 0 ? editing.value.modelKey.slice(split + 1) : editing.value.modelKey;
    const payload = { name: editing.value.name, description: editing.value.description, provider, model, prompt: editing.value.prompt };
    if (editing.value.id) await ipcRenderer.invoke('agent-definitions:update', editing.value.id, payload);
    else await ipcRenderer.invoke('agent-definitions:create', { ...payload, slug: editing.value.slug });
    editing.value = null;
    await loadDefinitions();
  } finally { saving.value = false }
}

async function removeDefinition(agent: AgentDefinitionResponse) {
  if (!window.confirm(`Delete ${ agent.name }? Existing filesystem files, if any, will be left untouched.`)) return;
  await ipcRenderer.invoke('agent-definitions:delete', agent.id);
  await loadDefinitions();
}

async function exportManifest(agent: AgentDefinitionResponse) {
  const manifest = await ipcRenderer.invoke('agent-definitions:export', agent.slug);
  const blob = new Blob([`${ JSON.stringify(manifest, null, 2) }\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${ agent.slug }.agent.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importManifest(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const manifest = JSON.parse(await file.text());
  await ipcRenderer.invoke('agent-definitions:import', manifest);
  await loadDefinitions();
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
  Promise.all([loadDefinitions(), loadModels()]).catch(error => console.warn('[Agents] Failed to load definitions or models:', error));
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

.agent-action, .agent-link { border-radius: .5rem; padding: .45rem .75rem; font-size: .75rem; }
.agent-action { background: var(--accent, #5096b3); color: white; }
.agent-link { color: var(--text-link, #5096b3); }
.agent-modal-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; background: rgba(0,0,0,.68); }
.agent-modal { width: min(680px, calc(100vw - 2rem)); display: grid; gap: 1rem; padding: 1.5rem; border: 1px solid var(--border-default); border-radius: .75rem; background: var(--bg-surface); }
.agent-modal label { display: grid; gap: .4rem; color: var(--text-muted); font-size: .75rem; }
.agent-modal input, .agent-modal select, .agent-modal textarea { width: 100%; border: 1px solid var(--border-default); border-radius: .5rem; padding: .65rem; background: var(--bg-page); color: var(--text-primary); }

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

.agent-avatar-tile,
.agent-modal-nav,
.agent-modal-heading {
  display: none;
}

.agent-modal-content {
  display: grid;
  gap: 1rem;
}

:global(.theme-noir-dark) .agents-page {
  background:
    radial-gradient(circle at 72% -10%, rgba(80, 150, 179, 0.09), transparent 35%),
    #01030a;
  color: #dee4ec;
}

:global(.theme-noir-dark) .agents-header {
  background: transparent;
  border-bottom: 1px solid rgba(168, 192, 220, 0.08);
}

:global(.theme-noir-dark) .agents-header .font-display {
  background: none;
  color: #f3f5f8;
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 3.25rem;
  font-weight: 600;
  letter-spacing: -0.035em;
}

:global(.theme-noir-dark) .agents-header .text-2xl {
  color: #a9b3c1;
  font-size: 0.875rem;
  letter-spacing: 0;
}

:global(.theme-noir-dark) .section-label {
  color: #6ab0cc;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.66rem;
  letter-spacing: 0.14em;
}

:global(.theme-noir-dark) .section-count,
:global(.theme-noir-dark) .badge {
  border: 1px solid rgba(168, 192, 220, 0.08);
  background: rgba(168, 192, 220, 0.05);
  color: #8cacc9;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

:global(.theme-noir-dark) .agents-card {
  display: grid;
  gap: 0.65rem;
  overflow: visible;
  background: transparent;
}

:global(.theme-noir-dark) .agents-card.agents-row,
:global(.theme-noir-dark) .agents-row {
  position: relative;
  border: 1px solid rgba(168, 192, 220, 0.08);
  border-radius: 18px;
  background: rgba(168, 192, 220, 0.035);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
  transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
}

:global(.theme-noir-dark) .agents-row:hover {
  transform: translateY(-2px);
  border-color: rgba(106, 176, 204, 0.25);
  background: rgba(80, 150, 179, 0.075);
}

:global(.theme-noir-dark) .agent-avatar-tile {
  position: relative;
  display: grid;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  place-items: center;
  border: 1px solid rgba(106, 176, 204, 0.24);
  border-radius: 13px;
  background: linear-gradient(145deg, rgba(106, 176, 204, 0.26), rgba(80, 150, 179, 0.07));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 10px 30px rgba(1, 3, 10, 0.35);
  color: #dee4ec;
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 1.15rem;
  font-weight: 600;
}

:global(.theme-noir-dark) .agent-live-dot {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 10px;
  height: 10px;
  border: 2px solid #070d1a;
  border-radius: 50%;
}

:global(.theme-noir-dark) .agent-live-dot-running {
  box-shadow: 0 0 0 3px rgba(63, 185, 80, 0.1), 0 0 10px rgba(63, 185, 80, 0.65);
  animation: agent-live-pulse 1.8s ease-in-out infinite;
}

:global(.theme-noir-dark) .agent-action {
  border: 1px solid rgba(106, 176, 204, 0.32);
  background: linear-gradient(135deg, #5096b3, #6ab0cc);
  box-shadow: 0 8px 24px rgba(80, 150, 179, 0.18);
  color: #01030a;
  font-weight: 650;
}

:global(.theme-noir-dark) .agent-link {
  color: #8cacc9;
}

:global(.theme-noir-dark) .agent-link:hover {
  background: rgba(80, 150, 179, 0.08);
  color: #dee4ec;
}

:global(.theme-noir-dark) .agent-modal-backdrop {
  padding: 2rem;
  background: rgba(1, 3, 10, 0.78);
  backdrop-filter: blur(18px);
}

:global(.theme-noir-dark) .agent-modal {
  grid-template-columns: 230px minmax(0, 1fr);
  gap: 0;
  width: min(900px, calc(100vw - 4rem));
  max-height: min(760px, calc(100vh - 4rem));
  overflow: hidden;
  padding: 0;
  border-color: rgba(168, 192, 220, 0.11);
  border-radius: 24px;
  background: rgba(7, 13, 26, 0.96);
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.58), inset 0 1px 0 rgba(255, 255, 255, 0.035);
}

:global(.theme-noir-dark) .agent-modal-nav {
  display: flex;
  flex-direction: column;
  padding: 30px 18px;
  border-right: 1px solid rgba(168, 192, 220, 0.08);
  background: rgba(3, 6, 12, 0.6);
}

:global(.theme-noir-dark) .agent-modal-nav h2 {
  margin: 6px 8px 4px;
  color: #f3f5f8;
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 1.35rem;
  font-weight: 600;
}

:global(.theme-noir-dark) .agent-modal-nav > p:not(.agent-modal-kicker) {
  margin: 0 8px 28px;
  color: #7a8291;
  font-size: 0.7rem;
  line-height: 1.5;
}

:global(.theme-noir-dark) .agent-modal-kicker,
:global(.theme-noir-dark) .agent-modal-heading > p {
  margin: 0 8px;
  color: #6ab0cc;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.62rem;
  letter-spacing: 0.14em;
}

:global(.theme-noir-dark) .agent-modal-nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  margin-bottom: 4px;
  padding: 0 14px;
  border-radius: 20px;
  color: #7a8291;
  font-size: 0.8rem;
}

:global(.theme-noir-dark) .agent-modal-nav-item span {
  color: #484f5a;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.62rem;
}

:global(.theme-noir-dark) .agent-modal-nav-current {
  border: 1px solid rgba(106, 176, 204, 0.22);
  background: linear-gradient(135deg, rgba(80, 150, 179, 0.18), rgba(80, 150, 179, 0.06));
  color: #dee4ec;
  box-shadow: 0 8px 28px rgba(80, 150, 179, 0.08);
}

:global(.theme-noir-dark) .agent-modal-nav-state {
  margin-top: auto;
  padding: 12px;
  border: 1px solid rgba(168, 192, 220, 0.08);
  border-radius: 14px;
  color: #7a8291;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.65rem;
}

:global(.theme-noir-dark) .agent-modal-nav-state span {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
  background: #e3b341;
  box-shadow: 0 0 8px rgba(227, 179, 65, 0.45);
}

:global(.theme-noir-dark) .agent-modal-content {
  display: grid;
  gap: 1rem;
  overflow: auto;
  padding: 30px 34px;
  animation: agent-section-in 360ms ease both;
}

:global(.theme-noir-dark) .agent-modal-legacy-title {
  display: none;
}

:global(.theme-noir-dark) .agent-modal-heading {
  display: block;
}

:global(.theme-noir-dark) .agent-modal-heading h3 {
  margin: 5px 0;
  color: #f3f5f8;
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 1.8rem;
  font-weight: 500;
  letter-spacing: -0.025em;
}

:global(.theme-noir-dark) .agent-modal-heading span {
  color: #7a8291;
  font-size: 0.78rem;
}

:global(.theme-noir-dark) .agent-modal label {
  color: #8cacc9;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.62rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

:global(.theme-noir-dark) .agent-modal input,
:global(.theme-noir-dark) .agent-modal select,
:global(.theme-noir-dark) .agent-modal textarea {
  border-color: rgba(168, 192, 220, 0.1);
  border-radius: 12px;
  background: rgba(3, 6, 12, 0.66);
  color: #dee4ec;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  letter-spacing: normal;
  text-transform: none;
}

:global(.theme-noir-dark) .agent-modal input:focus,
:global(.theme-noir-dark) .agent-modal select:focus,
:global(.theme-noir-dark) .agent-modal textarea:focus {
  border-color: rgba(106, 176, 204, 0.42);
  box-shadow: 0 0 0 3px rgba(80, 150, 179, 0.09);
  outline: none;
}

:global(.theme-noir-dark) .agent-modal-actions {
  position: sticky;
  bottom: -30px;
  margin: 0 -34px -30px;
  padding: 16px 34px;
  border-top: 1px solid rgba(168, 192, 220, 0.08);
  background: rgba(3, 6, 12, 0.9);
  backdrop-filter: blur(18px);
}

@keyframes agent-live-pulse {
  50% { opacity: 0.62; transform: scale(0.82); }
}

@keyframes agent-section-in {
  from { opacity: 0; filter: blur(8px); transform: translateY(8px); }
  to { opacity: 1; filter: blur(0); transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir-dark) .agent-live-dot-running,
  :global(.theme-noir-dark) .agent-modal-content {
    animation: none;
  }

  :global(.theme-noir-dark) .agents-row {
    transition: none;
  }
}
</style>
