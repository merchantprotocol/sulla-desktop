<template>
  <div class="monitor-dashboard" :class="{ dark: isDark }">
    <!-- Health Section -->
    <div v-if="activeSection === 'health'" class="dashboard-content">
      <div class="dashboard-header">
        <h2 class="dashboard-title">System Health</h2>
        <button class="refresh-btn" @click="$emit('refresh')">Refresh</button>
      </div>

      <!-- Active Agents -->
      <div class="panel">
        <h3 class="panel-title">Active Agents</h3>
        <div v-if="activeAgents.length === 0" class="empty-msg">No agents registered</div>
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Current Work</th>
                <th>Last Active</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="agent in activeAgents" :key="agent.agentId" class="clickable" @click="emit('open-detail', 'agent', agent.agentId, agent.name || agent.agentId)">
                <td class="cell-name">{{ agent.name || agent.agentId }}</td>
                <td class="cell-mono">{{ agent.channel }}</td>
                <td>
                  <span class="status-badge" :class="agent.status === 'running' ? 'badge-ok' : agent.status === 'idle' ? 'badge-neutral' : 'badge-err'">
                    {{ agent.status }}
                  </span>
                </td>
                <td class="cell-detail">{{ agent.statusNote || '-' }}</td>
                <td class="cell-detail">{{ formatAge(agent.lastActiveAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Service Health Cards -->
      <div class="card-grid">
        <div
          v-for="(svc, key) in health"
          :key="key"
          class="health-card clickable"
          :class="svc.ok ? 'health-ok' : 'health-err'"
          @click="emit('open-detail', 'service', String(key), svc.name)"
        >
          <div class="health-card-inner">
            <div class="health-dot" :class="svc.ok ? 'dot-ok' : 'dot-err'"></div>
            <div>
              <div class="health-name">{{ svc.name }}</div>
              <div class="health-detail">
                <span v-if="svc.port">Port {{ svc.port }}</span>
                <span v-if="svc.error" class="text-err"> {{ svc.error }}</span>
                <span v-else-if="svc.ok" class="text-ok">Healthy</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- WebSocket Connections -->
      <div class="panel">
        <h3 class="panel-title">WebSocket Connections</h3>
        <div v-if="Object.keys(wsStats).length === 0" class="empty-msg">No connections</div>
        <div v-else class="ws-list">
          <div v-for="(stat, channel) in wsStats" :key="channel" class="ws-row clickable" @click="emit('open-detail', 'ws', String(channel), `WS: ${channel}`)">
            <div>
              <span class="ws-channel">{{ channel }}</span>
              <div class="ws-subs">{{ stat.subscribedChannels?.join(', ') || 'no subscriptions' }}</div>
            </div>
            <div class="ws-status">
              <div class="ws-dot" :class="stat.connected ? 'dot-ok' : 'dot-err'"></div>
              <span>{{ stat.connected ? 'Connected' : 'Disconnected' }}</span>
              <span v-if="stat.reconnectAttempts > 0" class="text-warn">{{ stat.reconnectAttempts }} reconnects</span>
              <span v-if="stat.pendingMessages > 0" class="text-info">{{ stat.pendingMessages }} pending</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Heartbeat Section -->
    <div v-if="activeSection === 'heartbeat'" class="dashboard-content hb-layout">
      <!-- Top: Status + Schedule -->
      <div class="hb-top">
        <div class="dashboard-header">
          <h2 class="dashboard-title">Heartbeat</h2>
          <button class="refresh-btn" @click="$emit('refresh')">Refresh</button>
        </div>

        <!-- Status Cards -->
        <div class="card-grid-6">
          <div class="stat-card">
            <div class="stat-label">Status</div>
            <div class="stat-value-row">
              <div class="health-dot" :class="heartbeatStatus.initialized && heartbeatStatus.schedulerRunning ? 'dot-ok' : 'dot-err'"></div>
              <span class="stat-value">{{ heartbeatStatus.isExecuting ? 'Running' : heartbeatStatus.schedulerRunning ? 'Idle' : 'Stopped' }}</span>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Enabled</div>
            <div class="stat-value-row">
              <div class="health-dot" :class="heartbeatSchedule.enabled ? 'dot-ok' : 'dot-err'"></div>
              <span class="stat-value">{{ heartbeatSchedule.enabled ? 'Yes' : 'No' }}</span>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Interval</div>
            <div class="stat-value">{{ heartbeatSchedule.delayMinutes }}m</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Next Fire</div>
            <div class="stat-value stat-value-sm">{{ heartbeatSchedule.nextTriggerMs ? formatCountdown(heartbeatSchedule.nextTriggerMs) : '-' }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Total Triggers</div>
            <div class="stat-value">{{ heartbeatStatus.totalTriggers }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Errors</div>
            <div class="stat-value" :class="heartbeatStatus.totalErrors > 0 ? 'text-err' : ''">{{ heartbeatStatus.totalErrors }}</div>
          </div>
        </div>

        <!-- Execution Runs -->
        <div class="panel">
          <h3 class="panel-title">Execution Runs</h3>
          <div v-if="heartbeatRuns.length === 0" class="empty-msg">No executions yet</div>
          <div v-else class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Fired At</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Cycles</th>
                  <th>Focus</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(run, i) in heartbeatRuns" :key="i" :class="run.status === 'error' ? 'row-err' : run.status === 'completed' ? 'row-ok' : 'row-info'">
                  <td class="cell-mono cell-nowrap">{{ formatTime(run.triggeredAt) }}</td>
                  <td>
                    <span class="status-badge" :class="run.status === 'completed' ? 'badge-ok' : run.status === 'error' ? 'badge-err' : 'badge-info'">
                      {{ run.status }}
                    </span>
                  </td>
                  <td class="cell-mono">{{ run.durationMs ? formatDuration(run.durationMs) : 'running...' }}</td>
                  <td class="cell-mono">{{ run.cycles ?? '-' }}</td>
                  <td class="cell-detail cell-truncate">{{ run.focus || '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Event History -->
        <div class="panel">
          <h3 class="panel-title">Event History</h3>
          <div v-if="heartbeatHistory.length === 0" class="empty-msg">No events recorded yet</div>
          <div v-else class="event-scroll">
            <div
              v-for="(evt, i) in heartbeatHistory"
              :key="i"
              class="event-row"
              :class="eventRowClass(evt.type)"
            >
              <span class="event-time">{{ formatTime(evt.ts) }}</span>
              <span class="event-badge" :class="eventBadgeClass(evt.type)">{{ evt.type }}</span>
              <span class="event-msg">{{ evt.message }}</span>
              <span v-if="evt.durationMs" class="event-dur">{{ formatDuration(evt.durationMs) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Bottom Pane: WebSocket Messages -->
      <div class="hb-ws-pane panel">
        <div class="hb-ws-header">
          <h3 class="panel-title" style="margin-bottom: 0;">WebSocket Messages (heartbeat)</h3>
          <div class="hb-ws-controls">
            <button class="refresh-btn" :class="{ 'btn-active': wsTapEnabled }" @click="toggleWsTap">
              {{ wsTapEnabled ? 'Stop Tap' : 'Start Tap' }}
            </button>
            <button class="refresh-btn" @click="fetchWsMessages">Refresh</button>
          </div>
        </div>
        <div v-if="!wsTapEnabled" class="empty-msg" style="margin-top: 10px;">
          Tap is off. Click "Start Tap" to capture WebSocket messages on the heartbeat channel.
        </div>
        <div v-else-if="wsMessages.length === 0" class="empty-msg" style="margin-top: 10px;">No messages captured yet</div>
        <div v-else class="ws-msg-scroll">
          <div
            v-for="(msg, i) in wsMessages"
            :key="i"
            class="ws-msg-row"
            :class="msg.direction === 'in' ? 'row-info' : 'row-ok'"
          >
            <span class="event-time">{{ formatTime(msg.ts) }}</span>
            <span class="event-badge" :class="msg.direction === 'in' ? 'badge-info' : 'badge-ok'">{{ msg.direction === 'in' ? 'IN' : 'OUT' }}</span>
            <span class="ws-msg-type">{{ msg.message?.type || 'unknown' }}</span>
            <span class="event-msg ws-msg-data">{{ formatWsData(msg.message) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Conversations Section -->
    <div v-if="activeSection === 'conversations'" class="dashboard-content">
      <div class="dashboard-header">
        <h2 class="dashboard-title">Conversations</h2>
        <button class="refresh-btn" @click="$emit('refresh')">Refresh</button>
      </div>

      <!-- Filter -->
      <div class="filter-bar">
        <input
          v-model="convSearch"
          type="text"
          placeholder="Search conversations..."
          class="filter-input"
        />
        <select v-model="convTypeFilter" class="filter-select">
          <option value="">All Types</option>
          <option value="graph">Graph</option>
          <option value="workflow">Workflow</option>
        </select>
        <select v-model="convStatusFilter" class="filter-select">
          <option value="">All Statuses</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="error">Error</option>
        </select>
        <select v-model="convWorkflowFilter" class="filter-select">
          <option value="">All Workflows</option>
          <option v-for="wf in uniqueWorkflows" :key="wf" :value="wf">{{ wf }}</option>
        </select>
        <select v-model="convThreadFilter" class="filter-select">
          <option value="">All Threads</option>
          <option v-for="tid in uniqueThreadIds" :key="tid" :value="tid">{{ tid.slice(0, 12) }}...</option>
        </select>
      </div>

      <!-- Conversation List -->
      <div v-if="filteredConversations.length === 0" class="panel empty-panel">
        <p class="empty-msg">No conversations found</p>
      </div>
      <div v-else class="conv-list">
        <div
          v-for="conv in filteredConversations"
          :key="conv.id"
          class="conv-card"
          @click="toggleConversation(conv.id)"
        >
          <div class="conv-header">
            <div class="conv-left">
              <span class="conv-type-badge" :class="conv.type === 'graph' ? 'badge-info' : 'badge-purple'">{{ conv.type }}</span>
              <span class="conv-name">{{ conv.name }}</span>
              <span v-if="conv.channel" class="conv-channel">{{ conv.channel }}</span>
            </div>
            <div class="conv-right">
              <span :class="conv.status === 'error' || conv.status === 'failed' ? 'text-err' : conv.status === 'running' ? 'text-info' : 'text-ok'">
                {{ conv.status || 'unknown' }}
              </span>
              <span class="conv-time">{{ formatTimestamp(conv.startedAt) }}</span>
              <svg class="conv-chevron" :class="{ open: expandedConv === conv.id }" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 9l-7 7-7-7"/></svg>
            </div>
          </div>

          <!-- Expanded: Event Timeline -->
          <div v-if="expandedConv === conv.id" class="conv-events">
            <div v-if="convEventsLoading" class="empty-msg">Loading events...</div>
            <div v-else-if="convEvents.length === 0" class="empty-msg">No events</div>
            <div v-else class="conv-event-scroll">
              <div
                v-for="(evt, i) in convEvents"
                :key="i"
                class="conv-event-row"
                :class="convEventRowClass(evt.type)"
              >
                <span class="event-time">{{ formatTimestamp(evt.ts) }}</span>
                <span class="event-badge" :class="convEventBadgeClass(evt.type)">{{ evt.type }}</span>
                <span class="event-msg">
                  <template v-if="evt.type === 'message'">
                    <span class="msg-role" :class="evt.role === 'user' ? 'text-info' : evt.role === 'assistant' ? 'text-ok' : ''">{{ evt.role }}:</span>
                    {{ truncateText(String(evt.content || ''), 300) }}
                  </template>
                  <template v-else-if="evt.type === 'tool_call'">
                    <span class="text-warn-strong">{{ evt.toolName }}</span>
                    <span v-if="evt.result && typeof evt.result === 'object' && (evt.result as any).error" class="text-err"> ERROR: {{ (evt.result as any).error }}</span>
                  </template>
                  <template v-else-if="evt.type === 'llm_call'">
                    LLM {{ evt.direction }} <span v-if="evt.model" class="cell-detail">model={{ evt.model }}</span>
                  </template>
                  <template v-else>
                    {{ JSON.stringify(Object.fromEntries(Object.entries(evt).filter(([k]) => !['ts', 'type'].includes(k))), null, 0).slice(0, 200) }}
                  </template>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Errors Section -->
    <div v-if="activeSection === 'errors'" class="dashboard-content">
      <div class="dashboard-header">
        <h2 class="dashboard-title">Errors</h2>
        <button class="refresh-btn" @click="$emit('refresh')">Refresh</button>
      </div>

      <div v-if="errors.length === 0" class="panel empty-panel">
        <p class="empty-msg text-ok" style="font-size: 16px; font-weight: 500;">No errors found</p>
        <p class="empty-msg">System is running clean</p>
      </div>
      <div v-else class="panel">
        <table class="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Source</th>
              <th>Type</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(err, i) in errors" :key="i" class="clickable" @click="emit('open-detail', 'error', err.conversationId || String(i), err.name, err)">
              <td class="cell-mono cell-nowrap">{{ formatTimestamp(err.startedAt) }}</td>
              <td class="cell-name">{{ err.name }}</td>
              <td><span class="status-badge badge-err">{{ err.type }}</span></td>
              <td class="cell-detail text-err cell-truncate">{{ err.error }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

const { ipcRenderer } = window.require('electron');

const props = defineProps<{
  isDark: boolean;
  activeSection: string;
}>();

const emit = defineEmits<{
  refresh: [];
  'open-detail': [type: 'ws' | 'service' | 'agent' | 'error', id: string, label: string, errorData?: any];
}>();

// ── Data ──
const health = ref<Record<string, any>>({});
const wsStats = ref<Record<string, any>>({});
const activeAgents = ref<any[]>([]);
const heartbeatStatus = ref<any>({ initialized: false, totalTriggers: 0, totalErrors: 0, totalSkips: 0 });
const heartbeatHistory = ref<any[]>([]);
const heartbeatSchedule = ref<{ enabled: boolean; delayMinutes: number; nextTriggerMs: number }>({ enabled: false, delayMinutes: 30, nextTriggerMs: 0 });
const wsTapEnabled = ref(false);
const wsMessages = ref<any[]>([]);
const conversations = ref<any[]>([]);
const errors = ref<any[]>([]);

// Conversation state
const convSearch = ref('');
const convTypeFilter = ref('');
const convStatusFilter = ref('');
const convWorkflowFilter = ref('');
const convThreadFilter = ref('');
const expandedConv = ref<string | null>(null);
const convEvents = ref<any[]>([]);
const convEventsLoading = ref(false);

const uniqueWorkflows = computed(() => {
  const names = new Set<string>();
  for (const c of conversations.value) {
    if (c.workflowId) names.add(c.name || c.workflowId);
  }
  return Array.from(names).sort();
});

const uniqueThreadIds = computed(() => {
  const ids = new Set<string>();
  for (const c of conversations.value) {
    const tid = c.parentId || c.id;
    if (tid) ids.add(tid);
  }
  return Array.from(ids);
});

const filteredConversations = computed(() => {
  let result = conversations.value;
  if (convTypeFilter.value) result = result.filter(c => c.type === convTypeFilter.value);
  if (convStatusFilter.value) result = result.filter(c => (c.status || '').includes(convStatusFilter.value));
  if (convWorkflowFilter.value) {
    // Find all workflow conversation IDs that match the filter
    const matchingWorkflowIds = new Set(
      conversations.value
        .filter(c => c.type === 'workflow' && (c.name || c.workflowId || '') === convWorkflowFilter.value)
        .map(c => c.id),
    );
    // Include the workflow itself OR any child conversation whose parentId matches
    result = result.filter(c => matchingWorkflowIds.has(c.id) || matchingWorkflowIds.has(c.parentId));
  }
  if (convThreadFilter.value) result = result.filter(c => c.id === convThreadFilter.value || c.parentId === convThreadFilter.value);
  if (convSearch.value) {
    const q = convSearch.value.toLowerCase();
    result = result.filter(c => (c.name || '').toLowerCase().includes(q) || (c.id || '').toLowerCase().includes(q) || (c.channel || '').toLowerCase().includes(q));
  }
  return result.slice().reverse();
});

// ── Fetching ──
async function fetchHealth() {
  try {
    const [h, ws, agents] = await Promise.all([
      ipcRenderer.invoke('debug-health-check'),
      ipcRenderer.invoke('debug-ws-stats'),
      ipcRenderer.invoke('debug-active-agents'),
    ]);
    health.value = h;
    wsStats.value = ws;
    activeAgents.value = agents;
  } catch (err) {
    console.error('[MonitorDashboard] Health fetch failed:', err);
  }
}

async function fetchHeartbeat() {
  try {
    const [status, history, schedule] = await Promise.all([
      ipcRenderer.invoke('debug-heartbeat-status'),
      ipcRenderer.invoke('debug-heartbeat-history', 100),
      ipcRenderer.invoke('debug-heartbeat-schedule'),
    ]);
    heartbeatStatus.value = status;
    heartbeatHistory.value = (history || []).reverse();
    heartbeatSchedule.value = schedule;
    if (wsTapEnabled.value) {
      await fetchWsMessages();
    }
  } catch (err) {
    console.error('[MonitorDashboard] Heartbeat fetch failed:', err);
  }
}

async function toggleWsTap() {
  wsTapEnabled.value = !wsTapEnabled.value;
  await ipcRenderer.invoke('debug-ws-tap', wsTapEnabled.value);
  if (wsTapEnabled.value) {
    await fetchWsMessages();
  } else {
    wsMessages.value = [];
  }
}

async function fetchWsMessages() {
  try {
    const msgs = await ipcRenderer.invoke('debug-ws-messages', 'heartbeat', 200);
    wsMessages.value = (msgs || []).reverse();
  } catch {
    wsMessages.value = [];
  }
}

async function fetchConversations() {
  try {
    conversations.value = await ipcRenderer.invoke('debug-conversations-list');
  } catch (err) {
    console.error('[MonitorDashboard] Conversations fetch failed:', err);
  }
}

async function fetchErrors() {
  try {
    errors.value = await ipcRenderer.invoke('debug-errors', 100);
  } catch (err) {
    console.error('[MonitorDashboard] Errors fetch failed:', err);
  }
}

async function refreshAll() {
  await Promise.all([fetchHealth(), fetchHeartbeat(), fetchConversations(), fetchErrors()]);
}

async function toggleConversation(id: string) {
  if (expandedConv.value === id) {
    expandedConv.value = null;
    convEvents.value = [];
    return;
  }
  expandedConv.value = id;
  convEventsLoading.value = true;
  try {
    convEvents.value = await ipcRenderer.invoke('debug-conversation-events', id);
  } catch {
    convEvents.value = [];
  } finally {
    convEventsLoading.value = false;
  }
}

// Expose refreshAll for parent to call
defineExpose({ refreshAll });

// Auto-refresh
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { refreshAll(); timer = setInterval(refreshAll, 15000); });
onUnmounted(() => { if (timer) clearInterval(timer); });

// Refresh when section changes
watch(() => props.activeSection, () => refreshAll());

// ── Formatting ──
function formatTime(ts: number): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function formatTimestamp(ts: string | number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatAge(ts: number): string {
  if (!ts) return 'never';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── Heartbeat runs (derived from event history) ──
const heartbeatRuns = computed(() => {
  const runs: { triggeredAt: number; status: string; durationMs?: number; cycles?: number; focus?: string }[] = [];
  const history = heartbeatHistory.value;
  // History is reversed (newest first), walk it to pair triggered→completed/error
  for (let i = 0; i < history.length; i++) {
    const evt = history[i];
    if (evt.type === 'heartbeat_triggered') {
      // Look ahead for the matching completed/error
      let matched = false;
      for (let j = i - 1; j >= 0; j--) {
        const next = history[j];
        if (next.type === 'heartbeat_completed' || next.type === 'heartbeat_error') {
          runs.push({
            triggeredAt: evt.ts,
            status:      next.type === 'heartbeat_completed' ? 'completed' : 'error',
            durationMs:  next.durationMs,
            cycles:      (next.meta as any)?.cycleCount,
            focus:       (next.meta as any)?.focus,
          });
          matched = true;
          break;
        }
        if (next.type === 'heartbeat_triggered') break;
      }
      if (!matched) {
        runs.push({ triggeredAt: evt.ts, status: 'running' });
      }
    }
  }
  return runs;
});

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function formatCountdown(targetMs: number): string {
  const diff = targetMs - Date.now();
  if (diff <= 0) return 'now';
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatWsData(msg: any): string {
  if (!msg) return '';
  const { type, id, timestamp, ...rest } = msg;
  const data = rest.data ?? rest;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return str.length > 200 ? str.slice(0, 200) + '...' : str;
}

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

// ── Style helpers ──
function eventRowClass(type: string): string {
  if (type.includes('error')) return 'row-err';
  if (type.includes('completed')) return 'row-ok';
  if (type.includes('triggered')) return 'row-info';
  return '';
}

function eventBadgeClass(type: string): string {
  if (type.includes('error')) return 'badge-err';
  if (type.includes('completed')) return 'badge-ok';
  if (type.includes('triggered') || type.includes('started')) return 'badge-info';
  if (type.includes('skipped') || type.includes('already')) return 'badge-warn';
  return 'badge-neutral';
}

function convEventRowClass(type: string): string {
  if (type === 'tool_call') return 'row-warn';
  if (type.includes('error') || type.includes('failed')) return 'row-err';
  return '';
}

function convEventBadgeClass(type: string): string {
  if (type === 'message') return 'badge-info';
  if (type === 'tool_call') return 'badge-warn';
  if (type === 'llm_call') return 'badge-purple';
  if (type.includes('started')) return 'badge-ok';
  if (type.includes('completed')) return 'badge-ok';
  return 'badge-neutral';
}
</script>

<style scoped>
.monitor-dashboard {
  height: 100%;
  overflow-y: auto;
  background: #ffffff;
  color: #334155;
}
.monitor-dashboard.dark {
  background: #0f172a;
  color: #cbd5e1;
}

.dashboard-content {
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}

.dashboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.dashboard-title {
  font-size: 20px;
  font-weight: 700;
  color: #0f172a;
}
.dark .dashboard-title { color: #f1f5f9; }

.refresh-btn {
  padding: 6px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}
.refresh-btn:hover { background: rgba(0,0,0,0.05); }
.dark .refresh-btn { border-color: #334155; }
.dark .refresh-btn:hover { background: rgba(255,255,255,0.05); }

/* ── Card Grids ── */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
  margin-bottom: 20px;
}

.card-grid-4 {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-bottom: 20px;
}

@media (max-width: 900px) {
  .card-grid-4 { grid-template-columns: repeat(2, 1fr); }
}

/* ── Health Cards ── */
.health-card {
  border-radius: 10px;
  border: 1px solid;
  padding: 14px;
}
.health-ok { border-color: #bbf7d0; background: #f0fdf4; }
.health-err { border-color: #fecaca; background: #fef2f2; }
.dark .health-ok { border-color: #166534; background: #052e16; }
.dark .health-err { border-color: #991b1b; background: #450a0a; }

.health-card-inner { display: flex; align-items: center; gap: 10px; }
.health-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.dot-ok { background: #22c55e; }
.dot-err { background: #ef4444; }
.dot-warn { background: #f59e0b; }
.health-name { font-size: 13px; font-weight: 600; color: #0f172a; }
.dark .health-name { color: #f1f5f9; }
.health-detail { font-size: 11px; color: #64748b; margin-top: 2px; }
.dark .health-detail { color: #94a3b8; }

/* ── Stat Cards ── */
.stat-card {
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  background: #ffffff;
  padding: 14px;
}
.dark .stat-card { border-color: #334155; background: #1e293b; }
.stat-label { font-size: 10px; font-weight: 600; text-transform: uppercase; color: #64748b; letter-spacing: 0.3px; }
.dark .stat-label { color: #94a3b8; }
.stat-value { font-size: 20px; font-weight: 600; color: #0f172a; margin-top: 4px; }
.stat-value-sm { font-size: 14px; }
.dark .stat-value { color: #f1f5f9; }
.stat-value-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }

/* ── Panels ── */
.panel {
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  background: #ffffff;
  padding: 18px;
  margin-bottom: 20px;
}
.dark .panel { border-color: #334155; background: #1e293b; }

.panel-title {
  font-size: 16px;
  font-weight: 600;
  color: #0f172a;
  margin-bottom: 14px;
}
.dark .panel-title { color: #f1f5f9; }

.empty-panel { text-align: center; padding: 40px 18px; }

/* ── Tables ── */
.table-wrap { overflow-x: auto; }
.data-table { width: 100%; font-size: 13px; border-collapse: collapse; }
.data-table th { text-align: left; font-weight: 500; color: #64748b; padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
.dark .data-table th { color: #94a3b8; border-color: #334155; }
.data-table td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; }
.dark .data-table td { border-color: #1e293b; }
.data-table tr:hover { background: rgba(0,0,0,0.02); }
.dark .data-table tr:hover { background: rgba(255,255,255,0.02); }

.cell-name { font-weight: 500; color: #0f172a; }
.dark .cell-name { color: #f1f5f9; }
.cell-mono { font-family: monospace; font-size: 11px; color: #64748b; }
.dark .cell-mono { color: #94a3b8; }
.cell-detail { font-size: 12px; color: #64748b; }
.dark .cell-detail { color: #94a3b8; }
.cell-nowrap { white-space: nowrap; }
.cell-truncate { max-width: 350px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── Badges ── */
.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}
.badge-ok { background: #dcfce7; color: #166534; }
.badge-err { background: #fecaca; color: #991b1b; }
.badge-info { background: #dbeafe; color: #1e40af; }
.badge-warn { background: #fef3c7; color: #92400e; }
.badge-purple { background: #ede9fe; color: #5b21b6; }
.badge-neutral { background: #f1f5f9; color: #475569; }
.dark .badge-ok { background: #052e16; color: #4ade80; }
.dark .badge-err { background: #450a0a; color: #f87171; }
.dark .badge-info { background: #172554; color: #60a5fa; }
.dark .badge-warn { background: #451a03; color: #fbbf24; }
.dark .badge-purple { background: #2e1065; color: #a78bfa; }
.dark .badge-neutral { background: #1e293b; color: #94a3b8; }

/* ── WebSocket ── */
.ws-list { display: flex; flex-direction: column; gap: 10px; }
.ws-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: 8px;
  background: #f8fafc;
}
.dark .ws-row { background: #0f172a; }
.ws-channel { font-family: monospace; font-size: 13px; font-weight: 500; color: #0f172a; }
.dark .ws-channel { color: #f1f5f9; }
.ws-subs { font-size: 11px; color: #64748b; margin-top: 2px; }
.dark .ws-subs { color: #94a3b8; }
.ws-status { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.ws-dot { width: 8px; height: 8px; border-radius: 50%; }

/* ── Events ── */
.event-scroll { max-height: 600px; overflow-y: auto; }
.event-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 13px;
}
.row-err { background: rgba(239, 68, 68, 0.06); }
.row-ok { background: rgba(34, 197, 94, 0.06); }
.row-info { background: rgba(59, 130, 246, 0.06); }
.row-warn { background: rgba(245, 158, 11, 0.06); }
.dark .row-err { background: rgba(239, 68, 68, 0.1); }
.dark .row-ok { background: rgba(34, 197, 94, 0.1); }
.dark .row-info { background: rgba(59, 130, 246, 0.1); }
.dark .row-warn { background: rgba(245, 158, 11, 0.1); }

.event-time { flex-shrink: 0; font-family: monospace; font-size: 11px; color: #94a3b8; }
.event-badge { flex-shrink: 0; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; }
.event-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.event-dur { flex-shrink: 0; font-size: 11px; color: #94a3b8; }

/* ── Conversations ── */
.filter-bar { display: flex; gap: 10px; margin-bottom: 16px; }
.filter-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
}
.filter-input::placeholder { color: #94a3b8; }
.dark .filter-input { border-color: #334155; background: #1e293b; color: #f1f5f9; }
.dark .filter-input::placeholder { color: #64748b; }
.filter-input:focus { outline: none; border-color: #3b82f6; }

.filter-select {
  padding: 8px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
}
.dark .filter-select { border-color: #334155; background: #1e293b; color: #f1f5f9; }

.conv-list { display: flex; flex-direction: column; gap: 8px; }
.conv-card {
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  background: #ffffff;
  cursor: pointer;
  transition: border-color 0.15s;
}
.conv-card:hover { border-color: #93c5fd; }
.dark .conv-card { border-color: #334155; background: #1e293b; }
.dark .conv-card:hover { border-color: #3b82f6; }

.conv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
}
.conv-left { display: flex; align-items: center; gap: 10px; }
.conv-right { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.conv-type-badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
.conv-name { font-weight: 500; font-size: 14px; color: #0f172a; }
.dark .conv-name { color: #f1f5f9; }
.conv-channel { font-family: monospace; font-size: 11px; color: #94a3b8; }
.conv-time { color: #94a3b8; }
.conv-chevron { color: #94a3b8; transition: transform 0.15s; flex-shrink: 0; }
.conv-chevron.open { transform: rotate(180deg); }

.conv-events {
  border-top: 1px solid #e2e8f0;
  padding: 12px 16px;
}
.dark .conv-events { border-color: #334155; }
.conv-event-scroll { max-height: 400px; overflow-y: auto; }
.conv-event-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
}

/* ── Text colors ── */
.text-ok { color: #22c55e; }
.text-err { color: #ef4444; }
.text-info { color: #3b82f6; }
.text-warn { color: #f59e0b; }
.text-warn-strong { font-weight: 500; color: #d97706; }
.dark .text-warn-strong { color: #fbbf24; }
.msg-role { font-weight: 500; }
.empty-msg { font-size: 13px; color: #94a3b8; }

/* ── Heartbeat Layout ── */
.hb-layout { display: flex; flex-direction: column; height: 100%; }
.hb-top { flex: 1; overflow-y: auto; }
.card-grid-6 {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 14px;
  margin-bottom: 20px;
}
@media (max-width: 1100px) { .card-grid-6 { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 700px) { .card-grid-6 { grid-template-columns: repeat(2, 1fr); } }

.hb-ws-pane {
  flex-shrink: 0;
  max-height: 280px;
  display: flex;
  flex-direction: column;
  margin-top: auto;
}
.hb-ws-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.hb-ws-controls { display: flex; gap: 8px; }
.btn-active { background: rgba(59, 130, 246, 0.1); border-color: #3b82f6; color: #3b82f6; }
.dark .btn-active { background: rgba(96, 165, 250, 0.15); border-color: #60a5fa; color: #60a5fa; }

.ws-msg-scroll { flex: 1; overflow-y: auto; max-height: 200px; }
.ws-msg-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
}
.ws-msg-type { flex-shrink: 0; font-weight: 500; font-family: monospace; font-size: 11px; color: #0f172a; }
.dark .ws-msg-type { color: #f1f5f9; }
.ws-msg-data { font-family: monospace; font-size: 11px; word-break: break-all; }

.clickable { cursor: pointer; transition: box-shadow 0.15s, background 0.15s; }
.clickable:hover { box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3); }
tr.clickable:hover { box-shadow: none; background: rgba(59, 130, 246, 0.06); }
.dark tr.clickable:hover { background: rgba(59, 130, 246, 0.1); }
</style>
