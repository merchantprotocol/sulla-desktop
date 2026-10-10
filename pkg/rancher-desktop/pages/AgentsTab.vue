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
          <!-- Loading state -->
          <div
            v-if="loading"
            class="flex items-center justify-center py-20 text-slate-500"
          >
            Loading agents...
          </div>

          <template v-else>
            <section>
              <div class="flex items-center justify-between mb-3">
                <h3 class="section-label !mb-0">
                  Custom agents
                  <span class="section-count">{{ customAgents.length }}</span>
                </h3>
                <button
                  type="button"
                  class="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500"
                  @click="openCreateAgent"
                >
                  New agent
                </button>
              </div>
              <div
                v-if="customAgents.length"
                class="space-y-1"
              >
                <div
                  v-for="agent in customAgents"
                  :key="agent.id"
                  class="agents-row group flex items-center gap-3 px-4 py-3 rounded-lg"
                >
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-slate-800 dark:text-slate-200 truncate">
                      {{ agent.name }}
                    </p>
                    <p class="text-xs text-slate-500 dark:text-slate-500 truncate mt-0.5">
                      {{ agent.model || 'Uses default model' }}<template v-if="agent.description">
                        · {{ agent.description }}
                      </template>
                    </p>
                  </div>
                  <button
                    type="button"
                    class="agent-action"
                    @click="openEditAgent(agent.id)"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    class="agent-action text-red-500 dark:text-red-400"
                    @click="deleteAgent(agent)"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <p
                v-else
                class="text-sm text-slate-500 dark:text-slate-500 px-1"
              >
                No custom agents yet.
              </p>
            </section>

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
                  :title="`View ${ agent.name } conversations`"
                  @click="openAgent(agent)"
                  @keydown.enter="openAgent(agent)"
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

    <div
      v-if="agentEditor.open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6"
      @click.self="closeAgentEditor"
    >
      <form
        class="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        @submit.prevent="saveAgent"
      >
        <div class="flex items-center justify-between gap-4">
          <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {{ agentEditor.id ? 'Edit agent' : 'New agent' }}
          </h2>
          <button
            type="button"
            class="agent-action"
            @click="closeAgentEditor"
          >
            Close
          </button>
        </div>

        <label class="agent-field">
          <span>Name</span>
          <input
            v-model="agentEditor.name"
            required
            class="agent-input"
          >
        </label>

        <label class="agent-field">
          <span>Model</span>
          <select
            v-model="agentEditor.modelKey"
            required
            class="agent-input"
          >
            <option
              v-for="model in modelOptions"
              :key="`${model.providerId}:${model.id}`"
              :value="`${model.providerId}:${model.id}`"
            >
              {{ model.providerName }} · {{ model.name }}
            </option>
          </select>
        </label>

        <label class="agent-field">
          <span>Prompt</span>
          <textarea
            v-model="agentEditor.prompt"
            rows="14"
            class="agent-input font-mono text-xs resize-y"
          />
        </label>

        <p
          v-if="agentEditor.error"
          class="mt-3 text-sm text-red-500"
        >
          {{ agentEditor.error }}
        </p>

        <div class="mt-5 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            @click="closeAgentEditor"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
            :disabled="agentEditor.saving"
          >
            {{ agentEditor.saving ? 'Saving…' : 'Save agent' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';

import { useTheme } from '@pkg/composables/useTheme';
import type { AgentsListResponse } from '@pkg/main/agentsIpc';
import type { CustomAgentSummary } from '@pkg/main/customAgentDefinitions';
import AgentConversations from '@pkg/pages/agents/AgentConversations.vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const POLL_MS = 3_000;

const { isDark } = useTheme();

const loading = ref(true);
const polling = ref(true);
const data = ref<AgentsListResponse>({
  agents: [], heartbeat: null, jobs: [], routines: [],
});
const customAgents = ref<CustomAgentSummary[]>([]);
const modelOptions = ref<{ id: string; name: string; providerId: string; providerName: string }[]>([]);
const defaultProviderId = ref('');
const agentEditor = ref({
  open: false, id: '', name: '', modelKey: '', prompt: '', saving: false, error: '',
});

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
    const [runtime, custom] = await Promise.all([
      ipcRenderer.invoke('agents:list' as any),
      ipcRenderer.invoke('agents-list'),
    ]);

    data.value = runtime;
    customAgents.value = custom;
    polling.value = true;
  } catch {
    // Leave the last snapshot in place; flag that the refresh failed.
    polling.value = false;
  } finally {
    loading.value = false;
  }
}

async function loadModelOptions() {
  const [providers, state] = await Promise.all([
    ipcRenderer.invoke('model-provider:get-providers'),
    ipcRenderer.invoke('model-provider:get-state'),
  ]);

  defaultProviderId.value = state.primaryProvider;
  const connected = providers.filter((provider: { connected?: boolean }) => provider.connected !== false);
  const groups = await Promise.all(connected.map(async(provider: { id: string; name: string }) => {
    const models = await ipcRenderer.invoke('model-provider:get-models', provider.id);

    return models.map((model: { id: string; name: string }) => ({
      id:           model.id,
      name:         model.name,
      providerId:   provider.id,
      providerName: provider.name,
    }));
  }));

  modelOptions.value = groups.flat();
}

async function openCreateAgent() {
  await loadModelOptions();
  const first = modelOptions.value[0];

  agentEditor.value = {
    open:     true,
    id:       '',
    name:     '',
    modelKey: first ? `${ first.providerId }:${ first.id }` : '',
    prompt:   '',
    saving:   false,
    error:    '',
  };
}

async function openEditAgent(id: string) {
  const [agent] = await Promise.all([
    ipcRenderer.invoke('agents-get', id),
    loadModelOptions(),
  ]);

  if (!agent) return;
  const providerId = agent.provider || modelOptions.value.find(model => model.id === agent.model)?.providerId || '';
  const editableProviderId = providerId || defaultProviderId.value;
  if (editableProviderId) {
    modelOptions.value = modelOptions.value.filter(model => model.providerId === editableProviderId);
  }
  if (agent.model && !modelOptions.value.some(model => model.id === agent.model && model.providerId === providerId)) {
    modelOptions.value.unshift({
      id: agent.model, name: agent.model, providerId, providerName: providerId || 'Current',
    });
  }
  agentEditor.value = {
    open:     true,
    id:       agent.id,
    name:     agent.name,
    modelKey: `${ providerId }:${ agent.model }`,
    prompt:   agent.prompt,
    saving:   false,
    error:    '',
  };
}

function closeAgentEditor() {
  agentEditor.value.open = false;
}

async function saveAgent() {
  const editor = agentEditor.value;
  const separator = editor.modelKey.indexOf(':');
  const provider = separator >= 0 ? editor.modelKey.slice(0, separator) : '';
  const model = separator >= 0 ? editor.modelKey.slice(separator + 1) : editor.modelKey;

  editor.saving = true;
  editor.error = '';
  try {
    if (editor.id) {
      await ipcRenderer.invoke('agents-update', editor.id, { name: editor.name, model, prompt: editor.prompt });
    } else {
      await ipcRenderer.invoke('agents-create', { name: editor.name, model, prompt: editor.prompt, provider });
    }
    customAgents.value = await ipcRenderer.invoke('agents-list');
    closeAgentEditor();
  } catch (err: any) {
    editor.error = err?.message || String(err);
  } finally {
    editor.saving = false;
  }
}

async function deleteAgent(agent: CustomAgentSummary) {
  if (!window.confirm(`Delete ${ agent.name }? This removes its config and prompt files.`)) return;
  await ipcRenderer.invoke('agents-delete', agent.id);
  customAgents.value = await ipcRenderer.invoke('agents-list');
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

.agent-action {
  font-size: 0.75rem;
  color: #64748b;
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
}

.agent-action:hover {
  background: rgba(100, 116, 139, 0.12);
}

.agent-field {
  display: grid;
  gap: 0.4rem;
  margin-top: 1rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: #64748b;
}

.agent-input {
  width: 100%;
  border: 1px solid rgba(100, 116, 139, 0.35);
  border-radius: 0.5rem;
  background: transparent;
  color: inherit;
  padding: 0.65rem 0.75rem;
  outline: none;
}

.agent-input:focus {
  border-color: #38bdf8;
  box-shadow: 0 0 0 1px #38bdf8;
}
</style>
