<template>
  <div class="monitor-detail" :class="{ dark: isDark }">
    <!-- WebSocket Messages View -->
    <template v-if="tabType === 'ws'">
      <div class="detail-toolbar">
        <span class="detail-label">WebSocket: <strong>{{ tabId }}</strong></span>
        <label class="tap-toggle">
          <input type="checkbox" :checked="tapping" @change="toggleTap" />
          <span>Live capture</span>
        </label>
        <button class="detail-btn" @click="fetchMessages">Refresh</button>
        <button class="detail-btn" @click="clearMessages">Clear</button>
        <span class="msg-count">{{ messages.length }} messages</span>
      </div>
      <div class="detail-scroll">
        <table class="msg-table">
          <thead>
            <tr>
              <th class="col-time">Time</th>
              <th class="col-dir">Dir</th>
              <th class="col-type">Type</th>
              <th class="col-channel">Channel</th>
              <th>Data</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(msg, i) in messages"
              :key="i"
              class="msg-row"
              :class="{ 'msg-in': msg.direction === 'in', 'msg-out': msg.direction === 'out' }"
              @click="selectedMsg = selectedMsg === i ? -1 : i"
            >
              <td class="cell-time">{{ formatTime(msg.ts) }}</td>
              <td class="cell-dir">
                <span :class="msg.direction === 'in' ? 'dir-in' : 'dir-out'">{{ msg.direction === 'in' ? '◀ IN' : '▶ OUT' }}</span>
              </td>
              <td class="cell-type">{{ msg.message?.type || '-' }}</td>
              <td class="cell-channel">{{ msg.message?.channel || '-' }}</td>
              <td class="cell-data">{{ summarizeData(msg.message) }}</td>
            </tr>
          </tbody>
        </table>
        <!-- Expanded message detail -->
        <div v-if="selectedMsg >= 0 && messages[selectedMsg]" class="msg-detail">
          <pre class="msg-json">{{ JSON.stringify(messages[selectedMsg].message, null, 2) }}</pre>
        </div>
      </div>
    </template>

    <!-- Service Detail View -->
    <template v-else-if="tabType === 'service'">
      <div class="detail-toolbar">
        <span class="detail-label">Service: <strong>{{ tabId }}</strong></span>
        <button class="detail-btn" @click="fetchServiceDetail">Refresh</button>
      </div>
      <div class="detail-scroll">
        <!-- Heartbeat service -->
        <template v-if="serviceDetail?.type === 'heartbeat'">
          <div class="kv-grid">
            <div class="kv-row"><span class="kv-key">Status</span><span class="kv-val" :class="serviceDetail.status?.schedulerRunning ? 'text-ok' : 'text-err'">{{ serviceDetail.status?.isExecuting ? 'Executing' : serviceDetail.status?.schedulerRunning ? 'Idle' : 'Stopped' }}</span></div>
            <div class="kv-row"><span class="kv-key">Triggers</span><span class="kv-val">{{ serviceDetail.status?.totalTriggers }}</span></div>
            <div class="kv-row"><span class="kv-key">Errors</span><span class="kv-val" :class="serviceDetail.status?.totalErrors > 0 ? 'text-err' : ''">{{ serviceDetail.status?.totalErrors }}</span></div>
            <div class="kv-row"><span class="kv-key">Skips</span><span class="kv-val">{{ serviceDetail.status?.totalSkips }}</span></div>
            <div class="kv-row"><span class="kv-key">Uptime</span><span class="kv-val">{{ formatDuration(serviceDetail.status?.uptimeMs) }}</span></div>
            <div class="kv-row"><span class="kv-key">Last Trigger</span><span class="kv-val">{{ serviceDetail.status?.lastTriggerMs ? formatTime(serviceDetail.status.lastTriggerMs) : 'Never' }}</span></div>
          </div>
          <div class="event-log-header">Event Log ({{ serviceDetail.events?.length || 0 }} entries)</div>
          <div class="event-log">
            <div
              v-for="(evt, i) in (serviceDetail.events || []).slice().reverse()"
              :key="i"
              class="log-line"
              :class="logLineClass(evt.type)"
            >
              <span class="log-time">{{ formatTime(evt.ts) }}</span>
              <span class="log-type">{{ evt.type }}</span>
              <span class="log-msg">{{ evt.message }}</span>
              <span v-if="evt.durationMs" class="log-dur">{{ (evt.durationMs / 1000).toFixed(1) }}s</span>
              <span v-if="evt.error" class="log-err">{{ evt.error }}</span>
            </div>
          </div>
        </template>

        <!-- Redis -->
        <template v-else-if="serviceDetail?.type === 'redis'">
          <pre class="service-info">{{ serviceDetail.info }}</pre>
        </template>

        <!-- Port probe result -->
        <template v-else-if="serviceDetail?.type === 'probe'">
          <div class="kv-grid">
            <div class="kv-row"><span class="kv-key">Port</span><span class="kv-val">{{ serviceDetail.port }}</span></div>
            <div class="kv-row"><span class="kv-key">Status</span><span class="kv-val" :class="serviceDetail.ok ? 'text-ok' : 'text-err'">{{ serviceDetail.ok ? 'Healthy' : 'Down' }}</span></div>
            <div v-if="serviceDetail.statusCode" class="kv-row"><span class="kv-key">HTTP Status</span><span class="kv-val">{{ serviceDetail.statusCode }}</span></div>
            <div v-if="serviceDetail.error" class="kv-row"><span class="kv-key">Error</span><span class="kv-val text-err">{{ serviceDetail.error }}</span></div>
            <div v-if="serviceDetail.body" class="kv-row kv-full"><span class="kv-key">Response</span><pre class="kv-pre">{{ serviceDetail.body }}</pre></div>
          </div>
        </template>

        <template v-else>
          <pre class="service-info">{{ JSON.stringify(serviceDetail, null, 2) }}</pre>
        </template>
      </div>
    </template>

    <!-- Agent Detail View -->
    <template v-else-if="tabType === 'agent'">
      <div class="detail-toolbar">
        <span class="detail-label">Agent: <strong>{{ tabId }}</strong></span>
        <button class="detail-btn" @click="fetchAgentEvents">Refresh</button>
      </div>
      <div class="detail-scroll">
        <div v-if="agentEvents.length === 0" class="empty-msg">No events found</div>
        <div v-else class="event-log">
          <div
            v-for="(evt, i) in agentEvents"
            :key="i"
            class="log-line"
            :class="convLogClass(evt.type)"
          >
            <span class="log-time">{{ formatTimestamp(evt.ts) }}</span>
            <span class="log-type">{{ evt.type }}</span>
            <span class="log-msg">
              <template v-if="evt.type === 'message'">
                <strong :class="evt.role === 'user' ? 'text-info' : 'text-ok'">{{ evt.role }}:</strong>
                {{ truncate(String(evt.content || ''), 500) }}
              </template>
              <template v-else-if="evt.type === 'tool_call'">
                <strong class="text-warn">{{ evt.toolName }}</strong>
                <span v-if="evt.result && typeof evt.result === 'object' && (evt.result as any).error" class="text-err"> ERROR: {{ (evt.result as any).error }}</span>
              </template>
              <template v-else>
                {{ JSON.stringify(Object.fromEntries(Object.entries(evt).filter(([k]) => !['ts','type'].includes(k))), null, 0).slice(0, 300) }}
              </template>
            </span>
          </div>
        </div>
      </div>
    </template>

    <!-- Error Detail View -->
    <template v-else-if="tabType === 'error'">
      <div class="detail-toolbar">
        <span class="detail-label">Error: <strong>{{ tabId }}</strong></span>
        <button class="detail-btn" @click="fetchAgentEvents">Load Conversation</button>
      </div>
      <div class="detail-scroll">
        <div v-if="errorData" class="kv-grid">
          <div class="kv-row"><span class="kv-key">Source</span><span class="kv-val">{{ errorData.name }}</span></div>
          <div class="kv-row"><span class="kv-key">Type</span><span class="kv-val">{{ errorData.type }}</span></div>
          <div class="kv-row"><span class="kv-key">Time</span><span class="kv-val">{{ errorData.startedAt }}</span></div>
          <div class="kv-row kv-full"><span class="kv-key">Error</span><span class="kv-val text-err">{{ errorData.error }}</span></div>
        </div>
        <div v-if="agentEvents.length > 0">
          <div class="event-log-header">Conversation Events</div>
          <div class="event-log">
            <div
              v-for="(evt, i) in agentEvents"
              :key="i"
              class="log-line"
              :class="convLogClass(evt.type)"
            >
              <span class="log-time">{{ formatTimestamp(evt.ts) }}</span>
              <span class="log-type">{{ evt.type }}</span>
              <span class="log-msg">{{ truncate(JSON.stringify(evt), 300) }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';

const { ipcRenderer } = window.require('electron');

const props = defineProps<{
  isDark: boolean;
  tabType: 'ws' | 'service' | 'agent' | 'error';
  tabId: string;
  errorData?: any;
}>();

// ── WebSocket messages ──
const messages = ref<any[]>([]);
const tapping = ref(false);
const selectedMsg = ref(-1);
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function toggleTap() {
  tapping.value = !tapping.value;
  await ipcRenderer.invoke('debug-ws-tap', tapping.value);
  if (tapping.value) {
    startPolling();
  } else {
    stopPolling();
  }
}

async function fetchMessages() {
  try {
    messages.value = await ipcRenderer.invoke('debug-ws-messages', props.tabId, 200);
  } catch { /* ignore */ }
}

function clearMessages() {
  messages.value = [];
  selectedMsg.value = -1;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(fetchMessages, 1500);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Service detail ──
const serviceDetail = ref<any>(null);

async function fetchServiceDetail() {
  try {
    serviceDetail.value = await ipcRenderer.invoke('debug-service-detail', props.tabId);
  } catch (err) {
    serviceDetail.value = { type: 'error', error: String(err) };
  }
}

// ── Agent events ──
const agentEvents = ref<any[]>([]);

async function fetchAgentEvents() {
  try {
    // tabId is the conversationId for agent/error tabs
    agentEvents.value = await ipcRenderer.invoke('debug-conversation-events', props.tabId);
  } catch { agentEvents.value = []; }
}

// ── Lifecycle ──
onMounted(async () => {
  if (props.tabType === 'ws') {
    tapping.value = true;
    await ipcRenderer.invoke('debug-ws-tap', true);
    await fetchMessages();
    startPolling();
  } else if (props.tabType === 'service') {
    await fetchServiceDetail();
  } else if (props.tabType === 'agent') {
    await fetchAgentEvents();
  } else if (props.tabType === 'error') {
    if (props.errorData?.conversationId) {
      await fetchAgentEvents();
    }
  }
});

onUnmounted(() => {
  stopPolling();
});

// Refresh when tabId changes
watch(() => props.tabId, async () => {
  if (props.tabType === 'ws') await fetchMessages();
  else if (props.tabType === 'service') await fetchServiceDetail();
  else if (props.tabType === 'agent') await fetchAgentEvents();
});

// ── Formatting ──
function formatTime(ts: number): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) +
    '.' + String(new Date(ts).getMilliseconds()).padStart(3, '0');
}

function formatTimestamp(ts: string | number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function formatDuration(ms: number): string {
  if (!ms) return '-';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function summarizeData(msg: any): string {
  if (!msg) return '-';
  if (msg.type === 'ack') return `ack: ${msg.originalId?.slice(0, 8) || '-'}`;
  if (msg.type === 'ping') return 'heartbeat';
  if (msg.type === 'subscribe') return `channel: ${msg.channel}`;
  const data = msg.data;
  if (!data) return '-';
  if (typeof data === 'string') return data.slice(0, 80);
  return JSON.stringify(data).slice(0, 80);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function logLineClass(type: string): string {
  if (type.includes('error')) return 'line-err';
  if (type.includes('completed')) return 'line-ok';
  if (type.includes('triggered') || type.includes('started')) return 'line-info';
  if (type.includes('skipped')) return 'line-warn';
  return '';
}

function convLogClass(type: string): string {
  if (type === 'tool_call') return 'line-warn';
  if (type === 'message') return '';
  if (type.includes('error') || type.includes('failed')) return 'line-err';
  return '';
}
</script>

<style scoped>
.monitor-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: #334155;
  background: #ffffff;
}
.monitor-detail.dark {
  color: #cbd5e1;
  background: #0f172a;
}

.detail-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
  font-size: 12px;
}
.dark .detail-toolbar { border-color: var(--border-default, #334155); }

.detail-label { display: flex; align-items: center; gap: 4px; }
.detail-label strong { color: #0f172a; }
.dark .detail-label strong { color: #f1f5f9; }

.tap-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  cursor: pointer;
  user-select: none;
}
.tap-toggle input { cursor: pointer; }

.detail-btn {
  padding: 3px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 11px;
}
.detail-btn:hover { background: rgba(0,0,0,0.05); }
.dark .detail-btn { border-color: var(--border-default, #334155); }
.dark .detail-btn:hover { background: rgba(255,255,255,0.05); }

.msg-count { margin-left: auto; font-size: 11px; color: #94a3b8; }

.detail-scroll { flex: 1; overflow-y: auto; }

/* ── Message table ── */
.msg-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.msg-table th {
  position: sticky;
  top: 0;
  background: #f8fafc;
  text-align: left;
  font-weight: 500;
  padding: 4px 8px;
  border-bottom: 1px solid #e2e8f0;
  color: #64748b;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.dark .msg-table th { background: var(--bg-surface, #1e293b); border-color: var(--border-default, #334155); color: #94a3b8; }

.msg-row { cursor: pointer; }
.msg-row:hover { background: rgba(0,0,0,0.02); }
.dark .msg-row:hover { background: rgba(255,255,255,0.02); }

.msg-row td { padding: 3px 8px; border-bottom: 1px solid #f1f5f9; }
.dark .msg-row td { border-color: var(--bg-surface, #1e293b); }

.msg-in { }
.msg-out { }

.col-time { width: 100px; }
.col-dir { width: 55px; }
.col-type { width: 100px; }
.col-channel { width: 100px; }

.cell-time { font-family: monospace; color: #94a3b8; white-space: nowrap; }
.cell-dir { font-size: 10px; font-weight: 600; }
.dir-in { color: #3b82f6; }
.dir-out { color: #22c55e; }
.cell-type { font-weight: 500; }
.cell-channel { font-family: monospace; color: #64748b; }
.dark .cell-channel { color: #94a3b8; }
.cell-data { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 400px; color: #64748b; }
.dark .cell-data { color: #94a3b8; }

.msg-detail {
  padding: 8px 12px;
  border-top: 1px solid #e2e8f0;
  background: #f8fafc;
}
.dark .msg-detail { background: var(--bg-surface, #1e293b); border-color: var(--border-default, #334155); }
.msg-json {
  font-family: monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
  margin: 0;
}

/* ── Key-value grid ── */
.kv-grid { padding: 10px 12px; }
.kv-row { display: flex; gap: 12px; padding: 4px 0; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
.dark .kv-row { border-color: var(--bg-surface, #1e293b); }
.kv-full { flex-direction: column; }
.kv-key { width: 120px; flex-shrink: 0; font-weight: 500; color: #64748b; }
.dark .kv-key { color: #94a3b8; }
.kv-val { flex: 1; }
.kv-pre { font-family: monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all; margin: 4px 0 0; max-height: 200px; overflow-y: auto; }

/* ── Event log ── */
.event-log-header { padding: 8px 12px 4px; font-weight: 600; font-size: 12px; color: #0f172a; border-top: 1px solid #e2e8f0; }
.dark .event-log-header { color: #f1f5f9; border-color: var(--border-default, #334155); }

.event-log { padding: 0 4px; }

.log-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 2px;
}

.line-err { background: rgba(239, 68, 68, 0.06); }
.line-ok { background: rgba(34, 197, 94, 0.06); }
.line-info { background: rgba(59, 130, 246, 0.06); }
.line-warn { background: rgba(245, 158, 11, 0.06); }
.dark .line-err { background: rgba(239, 68, 68, 0.1); }
.dark .line-ok { background: rgba(34, 197, 94, 0.1); }
.dark .line-info { background: rgba(59, 130, 246, 0.1); }
.dark .line-warn { background: rgba(245, 158, 11, 0.1); }

.log-time { flex-shrink: 0; font-family: monospace; color: #94a3b8; width: 85px; }
.log-type { flex-shrink: 0; font-weight: 500; width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.log-dur { flex-shrink: 0; color: #94a3b8; }
.log-err { color: #ef4444; }

.service-info { font-family: monospace; font-size: 11px; padding: 12px; white-space: pre-wrap; word-break: break-all; margin: 0; }
.empty-msg { padding: 16px; text-align: center; color: #94a3b8; }

/* ── Text colors ── */
.text-ok { color: #22c55e; }
.text-err { color: #ef4444; }
.text-info { color: #3b82f6; }
.text-warn { color: #d97706; }
.dark .text-warn { color: #fbbf24; }
</style>
