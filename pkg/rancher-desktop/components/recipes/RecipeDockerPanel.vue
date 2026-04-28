<template>
  <div class="recipe-panel">
    <!-- Back nav -->
    <button
      class="btn-back"
      type="button"
      @click="emit('close')"
    >
      ← Library
    </button>

    <!-- Hero card -->
    <div
      class="hero-card"
      :class="{ 'is-running': isRunning, 'is-loading': statusLoading }"
    >
      <div class="hero-icon">
        {{ heroInitials }}
      </div>

      <div class="hero-info">
        <div class="hero-meta">
          <span class="badge-kind">Recipe</span>
          <span class="badge-slug">{{ slug }}</span>
        </div>
        <h2 class="hero-name">
          {{ name }}
        </h2>
        <p
          v-if="description"
          class="hero-desc"
        >
          {{ description }}
        </p>
      </div>

      <!-- Status badge only in hero-side -->
      <div class="hero-side">
        <div
          class="status-badge"
          :class="statusClass"
        >
          <span class="s-dot" />
          <span class="s-label">{{ statusLabel }}</span>
        </div>
      </div>
    </div>

    <!-- Action strip — always full-width and visible -->
    <div class="action-strip">
      <button
        class="btn-icon"
        type="button"
        :disabled="statusLoading"
        title="Refresh status"
        @click="refreshStatus"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>

      <button
        v-if="!isRunning"
        class="btn-start"
        type="button"
        :disabled="actionLoading"
        @click="startRecipe"
      >
        {{ actionLoading ? 'Starting…' : '▶ Start' }}
      </button>
      <button
        v-else
        class="btn-stop"
        type="button"
        :disabled="actionLoading"
        @click="stopRecipe"
      >
        {{ actionLoading ? 'Stopping…' : '■ Stop' }}
      </button>

      <button
        v-if="primaryPort"
        class="btn-open-app"
        type="button"
        :disabled="!isRunning || actionLoading"
        :title="isRunning ? `Open http://localhost:${primaryPortNum}` : 'Start the recipe first'"
        @click="openPrimaryApp"
      >
        <span class="open-label">Open App</span>
        <span class="open-port">:{{ primaryPortNum }}</span>
        <svg
          class="open-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
        >
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line
            x1="10"
            y1="14"
            x2="21"
            y2="3"
          />
        </svg>
      </button>
    </div>

    <!-- Secondary / other ports -->
    <div
      v-if="secondaryPorts.length > 0"
      class="secondary-ports"
    >
      <span class="ports-label">Other ports</span>
      <button
        v-for="p in secondaryPorts"
        :key="p"
        type="button"
        class="port-chip"
        @click="openPort(extractPortNum(p))"
      >
        :{{ extractPortNum(p) }}
      </button>
    </div>

    <!-- Services section -->
    <div
      v-if="containers.length > 0"
      class="services"
    >
      <div class="services-header">
        <span class="services-label">Services</span>
        <span class="services-count">{{ containers.length }}</span>
      </div>
      <div class="services-grid">
        <div
          v-for="c in containers"
          :key="c.name"
          class="service-card"
          :class="c.state === 'running' ? 'is-up' : c.state === 'not created' ? 'is-pending' : 'is-down'"
        >
          <div class="sc-status">
            <span class="sc-dot" />
            <span class="sc-state">{{ c.state === 'running' ? 'Running' : (c.state || 'Stopped') }}</span>
          </div>
          <div class="sc-name">
            {{ shortName(c.name) }}
          </div>
          <div
            v-if="c.ports.length"
            class="sc-ports"
          >
            <button
              v-for="p in c.ports"
              :key="p"
              type="button"
              class="sc-port"
              @click="openPort(extractPortNum(p))"
            >
              :{{ extractPortNum(p) }}
            </button>
          </div>
          <div
            v-else
            class="sc-no-port"
          >
            internal
          </div>
        </div>
      </div>
    </div>

    <!-- Startup console -->
    <div
      v-if="startupLines.length > 0"
      class="startup-console"
      :class="{ 'is-failed': startupFailed, 'is-done': startupDone && !startupFailed }"
    >
      <div class="sc-header">
        <span
          class="sc-header-dot"
          :class="{ 'is-spinning': !startupDone }"
        />
        <span class="sc-header-label">
          {{ !startupDone ? 'Starting containers…' : startupFailed ? 'Start failed' : 'Started' }}
        </span>
        <button
          class="sc-dismiss"
          type="button"
          @click="startupLines = []"
        >
          ✕
        </button>
      </div>
      <pre
        ref="startupOutputEl"
        class="sc-output"
      >{{ startupLines.join('') }}</pre>
    </div>

    <!-- Action feedback -->
    <div
      v-if="actionMsg && startupLines.length === 0"
      class="action-msg"
    >
      {{ actionMsg }}
    </div>

    <!-- Tabs -->
    <div class="tab-bar">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === t.id }"
        @click="activeTab = t.id"
      >
        {{ t.label }}
      </button>

      <!-- Log service selector -->
      <div
        v-if="activeTab === 'logs' && containers.length > 1"
        class="container-select-wrap"
      >
        <label class="container-select-label">filter</label>
        <select
          v-model="selectedLogService"
          class="container-select"
        >
          <option value="">
            all containers
          </option>
          <option
            v-for="c in containers"
            :key="c.name"
            :value="c.service"
          >
            {{ c.service }}
          </option>
        </select>
      </div>

      <!-- Shell container selector -->
      <div
        v-if="activeTab === 'shell' && containers.length > 1"
        class="container-select-wrap"
      >
        <label class="container-select-label">container</label>
        <select
          v-model="selectedShellContainer"
          class="container-select"
        >
          <option
            v-for="c in containers"
            :key="c.name"
            :value="c.name"
            :disabled="c.state !== 'running'"
          >
            {{ c.service }}{{ c.state !== 'running' ? ' (stopped)' : '' }}
          </option>
        </select>
      </div>
    </div>

    <div class="tab-content">
      <RecipeLogs
        v-if="activeTab === 'logs'"
        :key="`logs-${slug}-${selectedLogService}-${isRunning}`"
        :slug="slug"
        :service="selectedLogService || undefined"
      />
      <RecipeShell
        v-else-if="activeTab === 'shell'"
        :key="`shell-${slug}-${selectedShellContainer}`"
        :slug="slug"
        :containers="containers"
        :preferred-container="selectedShellContainer"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import RecipeLogs from '@pkg/components/recipes/RecipeLogs.vue';
import RecipeShell from '@pkg/components/recipes/RecipeShell.vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{
  slug: string;
  name: string;
  description?: string;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

type TabId = 'logs' | 'shell';
const TABS: { id: TabId; label: string }[] = [
  { id: 'logs', label: 'Logs' },
  { id: 'shell', label: 'Shell' },
];

const activeTab = ref<TabId>('logs');

interface Container { name: string; service: string; state: string; status: string; ports: string[] }

const containers = ref<Container[]>([]);
const statusLoading = ref(false);
const actionLoading = ref(false);
const actionMsg = ref('');
const selectedLogService = ref('');
const selectedShellContainer = ref('');

const startupLines = ref<string[]>([]);
const startupDone = ref(false);
const startupFailed = ref(false);
const startupOutputEl = ref<HTMLElement | null>(null);
let startupSession = '';

const isRunning = computed(() => containers.value.some(c => c.state === 'running'));
const runningCount = computed(() => containers.value.filter(c => c.state === 'running').length);

const statusClass = computed(() => {
  if (statusLoading.value) return 'loading';
  return isRunning.value ? 'running' : 'stopped';
});

const statusLabel = computed(() => {
  if (statusLoading.value) return 'Checking…';
  if (!isRunning.value) return 'Stopped';
  if (containers.value.length > 1) return `Running ${runningCount.value}/${containers.value.length}`;
  return 'Running';
});

const heroInitials = computed(() => {
  const words = (props.name || props.slug).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
});

const DB_PORTS = new Set(['5432', '3306', '6379', '27017', '5984', '9200', '5433', '27018', '1433', '1521', '5672', '15672', '2181', '11211']);
const WEB_PORT_ORDER = ['80', '443', '3000', '4000', '5000', '8000', '8080', '8888', '3001', '4200', '5173', '8090', '8443', '9000', '4321', '7474', '1880'];

function extractPortNum(portStr: string): string {
  const hostPart = portStr.split('→')[0].split('->')[0];
  return hostPart.split(':').pop()?.split('/')[0] ?? portStr;
}

const allPorts = computed((): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of containers.value) {
    for (const p of c.ports) {
      const host = p.split('→')[0].split('->')[0];
      if (!seen.has(host)) {
        seen.add(host);
        out.push(host);
      }
    }
  }
  return out;
});

const primaryPort = computed((): string | null => {
  if (allPorts.value.length === 0) return null;
  for (const preferred of WEB_PORT_ORDER) {
    const match = allPorts.value.find(p => extractPortNum(p) === preferred);
    if (match) return match;
  }
  const nonDb = allPorts.value.filter(p => !DB_PORTS.has(extractPortNum(p)));
  if (nonDb.length > 0) return nonDb[0];
  return allPorts.value[0];
});

const primaryPortNum = computed(() => (primaryPort.value ? extractPortNum(primaryPort.value) : ''));

const secondaryPorts = computed(() => {
  if (!primaryPort.value) return allPorts.value;
  return allPorts.value.filter(p => p !== primaryPort.value);
});

function shortName(containerName: string): string {
  return containerName.replace(new RegExp(`^${ props.slug }[-_]?`, 'i'), '') || containerName;
}

watch(containers, (list) => {
  const running = list.find(c => c.state === 'running');
  if (!selectedShellContainer.value || !list.find(c => c.name === selectedShellContainer.value)) {
    selectedShellContainer.value = running?.name ?? list[0]?.name ?? '';
  }
}, { immediate: true });

async function refreshStatus() {
  statusLoading.value = true;
  try {
    const res = await ipcRenderer.invoke('recipe-docker-status', props.slug) as {
      running: boolean;
      containers: Container[];
      error?: string;
    };
    containers.value = res.containers ?? [];
  } catch { /**/ } finally {
    statusLoading.value = false;
  }
}

function openPort(portNum: string) {
  const p = portNum.split(':').pop() ?? portNum;
  ipcRenderer.invoke('open-external', `http://localhost:${ p }`).catch(() => {
    window.open(`http://localhost:${ p }`, '_blank');
  });
}

function openPrimaryApp() {
  if (!primaryPort.value) return;
  openPort(primaryPortNum.value);
}

function onStartOutput(_: unknown, sid: string, chunk: string) {
  if (sid !== startupSession) return;
  startupLines.value.push(chunk);
  nextTick(() => {
    if (startupOutputEl.value) {
      startupOutputEl.value.scrollTop = startupOutputEl.value.scrollHeight;
    }
  });
}

async function onStartDone(_: unknown, sid: string, exitCode: number) {
  if (sid !== startupSession) return;
  ipcRenderer.off('recipe-start-output', onStartOutput);
  ipcRenderer.off('recipe-start-done', onStartDone);
  startupSession = '';
  startupDone.value = true;
  if (exitCode !== 0) {
    startupFailed.value = true;
    actionMsg.value = 'Start failed';
  } else {
    startupFailed.value = false;
    await new Promise(r => setTimeout(r, 1500));
    await refreshStatus();
    actionMsg.value = '';
  }
  actionLoading.value = false;
}

async function startRecipe() {
  actionLoading.value = true;
  actionMsg.value = '';
  startupLines.value = [];
  startupDone.value = false;
  startupFailed.value = false;
  try {
    const res = await ipcRenderer.invoke('recipe-start-stream', props.slug) as { sessionId: string };
    startupSession = res.sessionId;
    ipcRenderer.on('recipe-start-output', onStartOutput);
    ipcRenderer.on('recipe-start-done', onStartDone);
  } catch (err) {
    actionMsg.value = `Start failed: ${ err }`;
    actionLoading.value = false;
  }
}

async function stopRecipe() {
  actionLoading.value = true;
  actionMsg.value = 'Stopping…';
  try {
    await ipcRenderer.invoke('recipe-stop', props.slug);
    await new Promise(r => setTimeout(r, 1500));
    await refreshStatus();
    actionMsg.value = '';
  } catch (err) {
    actionMsg.value = `Stop failed: ${ err }`;
  } finally {
    actionLoading.value = false;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  refreshStatus();
  pollTimer = setInterval(refreshStatus, 5000);
});

onUnmounted(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  ipcRenderer.off('recipe-start-output', onStartOutput);
  ipcRenderer.off('recipe-start-done', onStartDone);
});
</script>

<style scoped>
/* ─── Layout ─────────────────────────────────────────────── */
.recipe-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-mono);
  overflow: hidden;
}

/* ─── Back nav ───────────────────────────────────────────── */
.btn-back {
  background: transparent;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 11px;
  font-family: var(--font-mono);
  letter-spacing: 0.08em;
  padding: 12px 16px 8px;
  text-align: left;
  flex-shrink: 0;
  transition: color 0.15s;
}
.btn-back:hover { color: var(--text); }

/* ─── Hero card ──────────────────────────────────────────── */
.hero-card {
  display: grid;
  grid-template-columns: 68px 1fr auto;
  gap: 18px;
  align-items: start;
  padding: 20px;
  margin: 0 16px 0;
  border-radius: 10px 10px 0 0;
  background: rgba(10, 18, 36, 0.6);
  border: 1px solid rgba(168, 192, 220, 0.14);
  border-bottom: none;
  flex-shrink: 0;
  transition: border-color 0.35s, box-shadow 0.35s;
}
.hero-card.is-running {
  border-color: rgba(57, 255, 20, 0.28);
  box-shadow: 0 0 32px rgba(57, 255, 20, 0.07), 0 0 80px rgba(57, 255, 20, 0.03);
}
.hero-card.is-loading { opacity: 0.75; }

.hero-icon {
  width: 68px;
  height: 68px;
  border-radius: 14px;
  background: linear-gradient(135deg, #a21caf, #c026d3);
  display: grid;
  place-items: center;
  color: white;
  font-size: 24px;
  font-weight: 700;
  border: 1px solid rgba(255, 255, 255, 0.15);
  flex-shrink: 0;
  letter-spacing: -0.02em;
}

.hero-info { min-width: 0; }

.hero-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.badge-kind {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 3px;
  background: rgba(192, 38, 211, 0.22);
  border: 1px solid rgba(192, 38, 211, 0.5);
  color: #e879f9;
}

.badge-slug {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
}

.hero-name {
  font-size: 20px;
  font-weight: 700;
  color: white;
  margin: 0 0 8px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero-desc {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.55;
}

/* ─── Action strip ───────────────────────────────────────── */
.action-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px 14px;
  margin: 0 16px 14px;
  border-radius: 0 0 10px 10px;
  background: rgba(10, 18, 36, 0.6);
  border: 1px solid rgba(168, 192, 220, 0.14);
  border-top: 1px solid rgba(168, 192, 220, 0.08);
  flex-shrink: 0;
}

/* ─── Hero side ──────────────────────────────────────────── */
.hero-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  flex-shrink: 0;
  padding-top: 2px;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px;
  border-radius: 20px;
  font-size: 11px;
  font-family: var(--font-mono);
  letter-spacing: 0.06em;
  border: 1px solid transparent;
  transition: all 0.3s;
  white-space: nowrap;
}
.status-badge.running {
  background: rgba(57, 255, 20, 0.1);
  border-color: rgba(57, 255, 20, 0.35);
  color: var(--green-bright);
}
.status-badge.stopped {
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.28);
  color: #f87171;
}
.status-badge.loading {
  background: rgba(251, 191, 36, 0.08);
  border-color: rgba(251, 191, 36, 0.28);
  color: #fbbf24;
}

.s-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-badge.running .s-dot {
  background: var(--green-bright);
  box-shadow: 0 0 8px var(--green-glow);
  animation: pulse-dot 2.4s ease-in-out infinite;
}
.status-badge.stopped .s-dot { background: #f87171; }
.status-badge.loading .s-dot { background: #fbbf24; animation: pulse-dot 1s ease-in-out infinite; }

@keyframes pulse-dot {
  0%, 100% { opacity: 1; box-shadow: 0 0 8px var(--green-glow); }
  50% { opacity: 0.65; box-shadow: 0 0 16px var(--green-glow); }
}

/* Open App CTA */
.btn-open-app {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border-radius: 7px;
  border: 1px solid var(--green);
  background: rgba(57, 255, 20, 0.1);
  color: var(--green-bright);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  letter-spacing: 0.04em;
  transition: all 0.2s;
  white-space: nowrap;
}
.btn-open-app:hover:not(:disabled) {
  background: rgba(57, 255, 20, 0.2);
  border-color: var(--green-bright);
  box-shadow: 0 0 18px rgba(57, 255, 20, 0.3);
}
.btn-open-app:disabled {
  opacity: 0.32;
  cursor: not-allowed;
}

.open-port { font-size: 11px; opacity: 0.65; }
.open-icon { width: 13px; height: 13px; flex-shrink: 0; }

/* Control row */
.control-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-icon {
  background: transparent;
  border: 1px solid rgba(168, 192, 220, 0.2);
  color: var(--text-muted);
  cursor: pointer;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  padding: 0;
  transition: all 0.15s;
}
.btn-icon:hover { background: var(--surface-2); color: var(--text); border-color: rgba(168, 192, 220, 0.4); }
.btn-icon svg { width: 13px; height: 13px; }
.btn-icon:disabled { opacity: 0.35; cursor: default; }

.btn-start {
  font-size: 11px;
  font-family: var(--font-mono);
  letter-spacing: 0.06em;
  padding: 6px 16px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid var(--green);
  background: var(--green);
  color: #000;
  font-weight: 700;
  transition: all 0.15s;
}
.btn-start:hover:not(:disabled) { background: var(--green-bright); box-shadow: 0 0 14px rgba(57, 255, 20, 0.45); }
.btn-start:disabled { opacity: 0.4; cursor: default; }

.btn-stop {
  font-size: 11px;
  font-family: var(--font-mono);
  letter-spacing: 0.06em;
  padding: 6px 16px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid rgba(239, 68, 68, 0.45);
  background: transparent;
  color: #f87171;
  transition: all 0.15s;
}
.btn-stop:hover:not(:disabled) { background: rgba(239, 68, 68, 0.14); border-color: #f87171; }
.btn-stop:disabled { opacity: 0.4; cursor: default; }

/* ─── Secondary ports ────────────────────────────────────── */
.secondary-ports {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px 12px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.ports-label {
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.port-chip {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--green);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 2px 8px;
  transition: all 0.15s;
}
.port-chip:hover { background: var(--surface-3); color: var(--green-bright); }

/* ─── Services ───────────────────────────────────────────── */
.services {
  flex-shrink: 0;
  padding: 0 16px 14px;
}

.services-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.services-label {
  font-size: 9px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.services-count {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
  background: rgba(10, 18, 36, 0.6);
  padding: 1px 7px;
  border-radius: 10px;
  border: 1px solid rgba(168, 192, 220, 0.14);
}

.services-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 8px;
}

.service-card {
  border-radius: 8px;
  padding: 12px 14px;
  border: 1px solid rgba(168, 192, 220, 0.1);
  background: rgba(10, 18, 36, 0.45);
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: all 0.25s;
}

.service-card.is-up {
  border-color: rgba(57, 255, 20, 0.22);
  background: rgba(57, 255, 20, 0.04);
  box-shadow: 0 0 14px rgba(57, 255, 20, 0.06);
}

.service-card.is-down {
  border-color: rgba(239, 68, 68, 0.15);
  background: rgba(127, 29, 29, 0.07);
}

.service-card.is-pending {
  border-color: rgba(168, 192, 220, 0.1);
  background: rgba(10, 18, 36, 0.3);
  opacity: 0.6;
}

.sc-status { display: flex; align-items: center; gap: 6px; }

.sc-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.service-card.is-up .sc-dot {
  background: var(--green-bright);
  box-shadow: 0 0 7px var(--green-glow);
}
.service-card.is-down .sc-dot { background: #f87171; }
.service-card.is-pending .sc-dot { background: var(--text-dim); }

.sc-state {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.service-card.is-up .sc-state { color: var(--green); }
.service-card.is-down .sc-state { color: #f87171; opacity: 0.7; }
.service-card.is-pending .sc-state { color: var(--text-dim); }

.sc-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sc-ports { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }

.sc-port {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid rgba(57, 255, 20, 0.22);
  background: rgba(57, 255, 20, 0.07);
  color: var(--green);
  cursor: pointer;
  font-family: var(--font-mono);
  transition: all 0.15s;
}
.sc-port:hover { background: rgba(57, 255, 20, 0.16); color: var(--green-bright); }

.sc-no-port { font-size: 10px; color: var(--text-dim); font-style: italic; }

/* ─── Startup console ────────────────────────────────────── */
.startup-console {
  flex-shrink: 0;
  margin: 0 16px 12px;
  border-radius: 8px;
  border: 1px solid rgba(251, 191, 36, 0.25);
  background: rgba(12, 10, 5, 0.85);
  overflow: hidden;
}
.startup-console.is-done {
  border-color: rgba(57, 255, 20, 0.3);
}
.startup-console.is-failed {
  border-color: rgba(239, 68, 68, 0.35);
}

.sc-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.sc-header-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #fbbf24;
}
.startup-console.is-done .sc-header-dot { background: var(--green-bright); }
.startup-console.is-failed .sc-header-dot { background: #f87171; }
.sc-header-dot.is-spinning { animation: spin-pulse 1s ease-in-out infinite; }
@keyframes spin-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.sc-header-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
  flex: 1;
}

.sc-dismiss {
  background: transparent;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 11px;
  padding: 0 2px;
  line-height: 1;
  transition: color 0.1s;
}
.sc-dismiss:hover { color: var(--text); }

.sc-output {
  margin: 0;
  padding: 10px 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
  color: #c8c8c8;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}

/* ─── Action feedback ────────────────────────────────────── */
.action-msg {
  flex-shrink: 0;
  padding: 6px 16px;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--surface-1);
  border-top: 1px solid var(--border-muted);
  border-bottom: 1px solid var(--border-muted);
}

/* ─── Tabs ───────────────────────────────────────────────── */
.tab-bar {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
  padding: 0 16px;
  gap: 4px;
}

.container-select-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.container-select-label { font-size: 10px; color: var(--text-dim); letter-spacing: 0.08em; }
.container-select {
  background: var(--surface-2);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 3px 8px;
  cursor: pointer;
  outline: none;
}
.container-select:focus { border-color: var(--green); }

.tab-btn {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  font-family: var(--font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 8px 14px;
  margin-bottom: -1px;
  transition: color 0.1s;
}
.tab-btn:hover { color: var(--text); }
.tab-btn.active { color: var(--green); border-bottom-color: var(--green); }

/* ─── Tab content ────────────────────────────────────────── */
.tab-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
