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

    <!-- Live Conversations Section -->
    <div v-if="activeSection === 'live'" class="dashboard-content live-layout">
      <div class="dashboard-header">
        <h2 class="dashboard-title">Live Conversations</h2>
        <div style="display: flex; gap: 8px; align-items: center;">
          <span v-if="livePolling" class="live-indicator">
            <span class="live-dot"></span> LIVE
          </span>
          <button class="refresh-btn" @click="fetchConversations">Refresh</button>
        </div>
      </div>

      <div class="live-split">
        <!-- Session List (left) -->
        <div class="live-sessions">
          <div class="live-sessions-header">
            <span class="live-sessions-title">Sessions</span>
            <span class="live-sessions-count">{{ activeConversations.length }} active</span>
          </div>
          <div v-if="liveConversations.length === 0" class="empty-msg" style="padding: 16px;">No conversations</div>
          <div
            v-for="conv in liveConversations"
            :key="conv.id"
            class="live-session-item"
            :class="{ selected: liveSelectedConv === conv.id, running: conv.status === 'running' }"
            @click="selectLiveConversation(conv.id)"
          >
            <div class="live-session-top">
              <span class="live-session-status">
                <span class="live-status-dot" :class="conv.status === 'running' ? 'dot-running' : conv.status === 'completed' ? 'dot-ok' : 'dot-err'"></span>
              </span>
              <span class="live-session-name">{{ conv.name || conv.id.slice(0, 16) }}</span>
            </div>
            <div class="live-session-meta">
              <span v-if="conv.channel" class="live-session-channel">{{ conv.channel }}</span>
              <span v-if="conv.agentId" class="live-session-agent">{{ conv.agentId }}</span>
              <span class="live-session-time">{{ formatTimestamp(conv.startedAt) }}</span>
            </div>
          </div>
        </div>

        <!-- Thread View (right) -->
        <div class="live-thread">
          <div v-if="!liveSelectedConv" class="live-thread-empty">
            <p class="empty-msg">Select a conversation to watch</p>
          </div>
          <template v-else>
            <div class="live-thread-header">
              <div class="live-thread-info">
                <span class="live-thread-name">{{ liveSelectedConvMeta?.name || liveSelectedConv?.slice(0, 20) }}</span>
                <span v-if="liveSelectedConvMeta" class="live-thread-detail">
                  {{ liveSelectedConvMeta.channel || '' }} · {{ liveSelectedConvMeta.agentId || '' }}
                </span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span
                  v-if="liveSelectedConvMeta"
                  class="status-badge"
                  :class="liveSelectedConvMeta.status === 'running' ? 'badge-info' : liveSelectedConvMeta.status === 'completed' ? 'badge-ok' : 'badge-err'"
                >
                  {{ liveSelectedConvMeta.status }}
                </span>
              </div>
            </div>
            <div ref="liveThreadScroll" class="live-thread-messages">
              <div v-if="liveEventsLoading && liveThreadEvents.length === 0" class="empty-msg" style="padding: 20px;">Loading...</div>
              <div v-else-if="liveThreadEvents.length === 0" class="empty-msg" style="padding: 20px;">No events yet</div>
              <template v-else>
                <div class="live-thread-spacer"></div>
                <template v-for="(evt, i) in liveThreadEvents" :key="i">
                  <!-- User message -->
                  <div v-if="evt.type === 'message' && evt.role === 'user'" class="live-msg live-msg-user">
                    <div class="live-bubble live-bubble-user">
                      <div class="live-bubble-content">{{ evt.content }}</div>
                    </div>
                    <div class="live-msg-time">{{ formatTimestamp(evt.ts) }}</div>
                  </div>

                  <!-- Assistant message -->
                  <div v-else-if="evt.type === 'message' && evt.role === 'assistant'" class="live-msg live-msg-assistant">
                    <div class="live-bubble live-bubble-assistant">
                      <div class="live-bubble-content prose-content" v-html="renderMarkdown(String(evt.content || ''))"></div>
                    </div>
                    <div class="live-msg-time">{{ formatTimestamp(evt.ts) }}</div>
                  </div>

                  <!-- System message -->
                  <div v-else-if="evt.type === 'message' && evt.role === 'system'" class="live-msg live-msg-system">
                    <div class="live-bubble live-bubble-system">
                      <div class="live-bubble-content">{{ truncateText(String(evt.content || ''), 500) }}</div>
                    </div>
                    <div class="live-msg-time">{{ formatTimestamp(evt.ts) }}</div>
                  </div>

                  <!-- Tool call -->
                  <div v-else-if="evt.type === 'tool_call'" class="live-msg live-msg-tool">
                    <div class="live-bubble live-bubble-tool" @click="toggleLiveToolCard(i)">
                      <div class="live-tool-header">
                        <span class="live-tool-icon">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                        </span>
                        <span class="live-tool-name">{{ evt.toolName }}</span>
                        <span
                          v-if="evt.result && typeof evt.result === 'object' && (evt.result as any).error"
                          class="live-tool-status-badge badge-err"
                        >error</span>
                        <span v-else class="live-tool-status-badge badge-ok">ok</span>
                        <svg
                          width="10" height="10" viewBox="0 0 15 15" fill="currentColor"
                          class="live-tool-chevron" :class="{ expanded: liveExpandedTools.has(i) }"
                        >
                          <path d="M3.13523 6.15803C3.3241 5.95657 3.64052 5.94637 3.84197 6.13523L7.5 9.56464L11.158 6.13523C11.3595 5.94637 11.6759 5.95657 11.8648 6.15803C12.0536 6.35949 12.0434 6.67591 11.842 6.86477L7.84197 10.6148C7.64964 10.7951 7.35036 10.7951 7.15803 10.6148L3.15803 6.86477C2.95657 6.67591 2.94637 6.35949 3.13523 6.15803Z" fill-rule="evenodd" clip-rule="evenodd"/>
                        </svg>
                      </div>
                      <div v-if="liveExpandedTools.has(i)" class="live-tool-details">
                        <div v-if="evt.args" class="live-tool-section">
                          <div class="live-tool-label">Args</div>
                          <pre class="live-tool-pre"><code>{{ typeof evt.args === 'string' ? evt.args : JSON.stringify(evt.args, null, 2) }}</code></pre>
                        </div>
                        <div v-if="evt.result !== undefined" class="live-tool-section">
                          <div class="live-tool-label">Result</div>
                          <pre class="live-tool-pre"><code>{{ typeof evt.result === 'string' ? evt.result : JSON.stringify(evt.result, null, 2) }}</code></pre>
                        </div>
                      </div>
                    </div>
                    <div class="live-msg-time">{{ formatTimestamp(evt.ts) }}</div>
                  </div>

                  <!-- LLM call (thinking) -->
                  <div v-else-if="evt.type === 'llm_call'" class="live-msg live-msg-thinking">
                    <div class="live-bubble live-bubble-thinking">
                      <span class="live-thinking-icon">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                      </span>
                      <span class="live-thinking-text">
                        {{ evt.direction === 'request' ? 'Thinking...' : 'Response received' }}
                        <span v-if="evt.model" class="live-thinking-model">{{ evt.model }}</span>
                      </span>
                    </div>
                  </div>

                  <!-- Node events -->
                  <div v-else-if="evt.type === 'node_event'" class="live-msg live-msg-node">
                    <div class="live-bubble live-bubble-node">
                      <span class="live-node-label">{{ evt.nodeLabel || evt.nodeId || 'node' }}</span>
                      <span v-if="evt.data" class="live-node-data">{{ truncateText(JSON.stringify(evt.data), 200) }}</span>
                    </div>
                  </div>

                  <!-- Graph lifecycle events -->
                  <div v-else-if="evt.type && (evt.type.includes('started') || evt.type.includes('completed'))" class="live-msg live-msg-lifecycle">
                    <div class="live-lifecycle-badge" :class="evt.type.includes('completed') ? 'lifecycle-completed' : 'lifecycle-started'">
                      {{ evt.type.replace(/_/g, ' ') }}
                      <span v-if="(evt as any).durationMs" class="live-lifecycle-dur">{{ formatDuration((evt as any).durationMs) }}</span>
                    </div>
                  </div>
                </template>

                <!-- Thinking indicator for running conversations -->
                <div v-if="liveSelectedConvMeta?.status === 'running' && isLiveThinking" class="live-msg live-msg-assistant">
                  <div class="live-bubble live-bubble-thinking-active">
                    <span class="live-thinking-anim">Sulla is thinking<span class="dot-anim">...</span></span>
                  </div>
                </div>
              </template>
            </div>
          </template>
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
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

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

// ── Live conversation spy state ──
const liveSelectedConv = ref<string | null>(null);
const liveThreadEvents = ref<any[]>([]);
const liveEventsLoading = ref(false);
const livePolling = ref(false);
const liveExpandedTools = reactive(new Set<number>());
const liveThreadScroll = ref<HTMLElement>();
let liveStreamActive = false;

const activeConversations = computed(() => conversations.value.filter(c => c.status === 'running'));
const liveConversations = computed(() => {
  // Show running first, then recent completed/failed
  const running = conversations.value.filter(c => c.status === 'running');
  const others = conversations.value.filter(c => c.status !== 'running').slice(0, 30);
  return [...running, ...others];
});

const liveSelectedConvMeta = computed(() => {
  if (!liveSelectedConv.value) return null;
  return conversations.value.find(c => c.id === liveSelectedConv.value) || null;
});

const isLiveThinking = computed(() => {
  if (liveThreadEvents.value.length === 0) return false;
  const last = liveThreadEvents.value[liveThreadEvents.value.length - 1];
  return last.type === 'llm_call' && last.direction === 'request';
});

function renderMarkdown(content: string): string {
  const raw = typeof content === 'string' ? content : String(content || '');
  const html = (marked(raw) as string) || '';
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function toggleLiveToolCard(index: number) {
  if (liveExpandedTools.has(index)) {
    liveExpandedTools.delete(index);
  } else {
    liveExpandedTools.add(index);
  }
}

function scrollLiveToBottom() {
  nextTick(() => {
    if (liveThreadScroll.value) {
      liveThreadScroll.value.scrollTop = liveThreadScroll.value.scrollHeight;
    }
  });
}

// IPC push handlers for real-time events
function onLiveConversation(_ipcEvent: any, data: any) {
  if (!data) return;
  if (data.kind === 'start' && data.meta) {
    // New conversation appeared — add to list if not already present
    const existing = conversations.value.find(c => c.id === data.meta.id);
    if (!existing) {
      conversations.value.unshift(data.meta);
    }
  } else if (data.kind === 'update' && data.meta) {
    // Conversation updated (completed, error, etc.)
    const idx = conversations.value.findIndex(c => c.id === data.meta.id);
    if (idx >= 0) {
      conversations.value[idx] = { ...conversations.value[idx], ...data.meta };
    }
  }
}

function onLiveEvent(_ipcEvent: any, data: any) {
  if (!data || !data.conversationId || !data.event) return;
  // Only append to the thread we're currently watching
  if (data.conversationId === liveSelectedConv.value) {
    liveThreadEvents.value.push(data.event);
    scrollLiveToBottom();
  }
}

async function startLiveStream() {
  if (liveStreamActive) return;
  liveStreamActive = true;
  livePolling.value = true;
  ipcRenderer.on('debug-live-conversation', onLiveConversation);
  ipcRenderer.on('debug-live-event', onLiveEvent);
  await ipcRenderer.invoke('debug-live-start');
}

async function stopLiveStream() {
  if (!liveStreamActive) return;
  liveStreamActive = false;
  livePolling.value = false;
  ipcRenderer.removeListener('debug-live-conversation', onLiveConversation);
  ipcRenderer.removeListener('debug-live-event', onLiveEvent);
  try {
    await ipcRenderer.invoke('debug-live-stop');
  } catch { /* ignore */ }
}

async function selectLiveConversation(id: string) {
  liveSelectedConv.value = id;
  liveExpandedTools.clear();
  // Load existing events for this conversation (historical)
  liveEventsLoading.value = true;
  try {
    const events = await ipcRenderer.invoke('debug-conversation-events', id);
    liveThreadEvents.value = events || [];
    scrollLiveToBottom();
  } catch {
    liveThreadEvents.value = [];
  } finally {
    liveEventsLoading.value = false;
  }
  // Start streaming new events in real-time
  await startLiveStream();
}

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
    const fetched = await ipcRenderer.invoke('debug-conversations-list') as any[];
    if (!fetched || fetched.length === 0) {
      // Don't overwrite live-pushed conversations with empty results
      return;
    }
    // Merge: fetched data is authoritative, but preserve any live-pushed
    // conversations not yet persisted to the index file
    const fetchedById = new Map(fetched.map((c: any) => [c.id, c]));
    const livePushedOnly = conversations.value.filter(c => !fetchedById.has(c.id));
    conversations.value = [...livePushedOnly, ...fetched];
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
onMounted(() => {
  refreshAll();
  timer = setInterval(refreshAll, 15000);
  if (props.activeSection === 'live') startLiveStream();
});
onUnmounted(() => { if (timer) clearInterval(timer); stopLiveStream(); });

// Refresh when section changes; start/stop live stream
watch(() => props.activeSection, (section) => {
  refreshAll();
  if (section === 'live') {
    startLiveStream();
  } else {
    stopLiveStream();
  }
});

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
.dark .refresh-btn { border-color: var(--border-default, #334155); }
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
.dark .stat-card { border-color: var(--border-default, #334155); background: var(--bg-surface, #1e293b); }
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
.dark .panel { border-color: var(--border-default, #334155); background: var(--bg-surface, #1e293b); }

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
.dark .data-table th { color: #94a3b8; border-color: var(--border-default, #334155); }
.data-table td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; }
.dark .data-table td { border-color: var(--bg-surface, #1e293b); }
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
.dark .badge-neutral { background: var(--bg-surface, #1e293b); color: #94a3b8; }

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
.dark .filter-input { border-color: var(--border-default, #334155); background: var(--bg-surface, #1e293b); color: #f1f5f9; }
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
.dark .filter-select { border-color: var(--border-default, #334155); background: var(--bg-surface, #1e293b); color: #f1f5f9; }

.conv-list { display: flex; flex-direction: column; gap: 8px; }
.conv-card {
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  background: #ffffff;
  cursor: pointer;
  transition: border-color 0.15s;
}
.conv-card:hover { border-color: #93c5fd; }
.dark .conv-card { border-color: var(--border-default, #334155); background: var(--bg-surface, #1e293b); }
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
.dark .conv-events { border-color: var(--border-default, #334155); }
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

/* ── Live Conversations ── */
.live-layout { padding: 0 !important; display: flex; flex-direction: column; height: 100%; }
.live-layout .dashboard-header { padding: 16px 24px 12px; flex-shrink: 0; }

.live-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: #ef4444;
  letter-spacing: 0.5px;
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ef4444;
  animation: livePulse 1.5s ease-in-out infinite;
}
@keyframes livePulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
  50% { opacity: 0.7; box-shadow: 0 0 0 4px rgba(239, 68, 68, 0); }
}

.live-split {
  flex: 1;
  display: flex;
  min-height: 0;
  border-top: 1px solid #e2e8f0;
}
.dark .live-split { border-color: var(--border-default, #334155); }

/* Sessions sidebar */
.live-sessions {
  width: 280px;
  flex-shrink: 0;
  border-right: 1px solid #e2e8f0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dark .live-sessions { border-color: var(--border-default, #334155); }

.live-sessions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.dark .live-sessions-header { border-color: var(--border-default, #334155); }
.live-sessions-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; color: #64748b; }
.dark .live-sessions-title { color: #94a3b8; }
.live-sessions-count { font-size: 10px; color: #94a3b8; }

.live-session-item {
  padding: 10px 14px;
  cursor: pointer;
  border-bottom: 1px solid #f1f5f9;
  transition: background 0.1s;
}
.live-session-item:hover { background: rgba(0, 0, 0, 0.03); }
.dark .live-session-item { border-color: var(--bg-surface, #1e293b); }
.dark .live-session-item:hover { background: rgba(255, 255, 255, 0.03); }
.live-session-item.selected { background: rgba(59, 130, 246, 0.08); border-left: 3px solid #3b82f6; }
.dark .live-session-item.selected { background: rgba(59, 130, 246, 0.12); }
.live-session-item.running { }

.live-session-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.live-session-status { flex-shrink: 0; }
.live-status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.dot-running { background: #3b82f6; animation: livePulse 1.5s ease-in-out infinite; }
.live-session-name {
  font-size: 13px;
  font-weight: 500;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dark .live-session-name { color: #f1f5f9; }

.live-session-meta {
  display: flex;
  gap: 8px;
  margin-top: 4px;
  padding-left: 16px;
  font-size: 11px;
  color: #94a3b8;
}
.live-session-channel { font-family: monospace; }
.live-session-agent { font-family: monospace; }
.live-session-time { margin-left: auto; }

/* Thread view */
.live-thread {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.live-thread-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.live-thread-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.dark .live-thread-header { border-color: var(--border-default, #334155); }
.live-thread-info { display: flex; flex-direction: column; gap: 2px; }
.live-thread-name { font-size: 14px; font-weight: 600; color: #0f172a; }
.dark .live-thread-name { color: #f1f5f9; }
.live-thread-detail { font-size: 11px; color: #94a3b8; }

.live-thread-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.live-thread-spacer { flex: 1; min-height: 0; }

/* Message bubbles */
.live-msg { display: flex; flex-direction: column; }
.live-msg-time { font-size: 10px; color: #94a3b8; margin-top: 2px; padding: 0 4px; }

.live-msg-user { align-items: flex-end; }
.live-msg-assistant { align-items: flex-start; }
.live-msg-system { align-items: center; }
.live-msg-tool { align-items: flex-start; }
.live-msg-thinking { align-items: center; }
.live-msg-node { align-items: center; }
.live-msg-lifecycle { align-items: center; }

.live-bubble {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.live-bubble-user {
  background: #e0f2fe;
  color: #0c4a6e;
  border-bottom-right-radius: 4px;
}
.dark .live-bubble-user {
  background: rgba(56, 189, 248, 0.15);
  color: #e0f2fe;
}

.live-bubble-assistant {
  background: #f1f5f9;
  color: #334155;
  border-bottom-left-radius: 4px;
}
.dark .live-bubble-assistant {
  background: rgba(255, 255, 255, 0.06);
  color: #e2e8f0;
}

.live-bubble-system {
  background: #fefce8;
  color: #713f12;
  font-size: 12px;
  max-width: 90%;
  border-radius: 8px;
}
.dark .live-bubble-system {
  background: rgba(250, 204, 21, 0.1);
  color: #fde68a;
}

.live-bubble-content { white-space: pre-wrap; }

.live-bubble .prose-content { white-space: normal; }
.live-bubble .prose-content :deep(p) { margin: 0 0 0.5em; }
.live-bubble .prose-content :deep(p:last-child) { margin-bottom: 0; }
.live-bubble .prose-content :deep(pre) {
  background: var(--bg-surface, #1e293b);
  color: #e2e8f0;
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
  margin: 4px 0;
}
.dark .live-bubble .prose-content :deep(pre) { background: #0f172a; }
.live-bubble .prose-content :deep(code) { font-size: 12px; font-family: 'Menlo', 'Monaco', 'Courier New', monospace; }
.live-bubble .prose-content :deep(code:not(pre code)) { background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 3px; }
.dark .live-bubble .prose-content :deep(code:not(pre code)) { background: rgba(255,255,255,0.1); }

/* Tool call bubble */
.live-bubble-tool {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  color: #475569;
  font-size: 12px;
  padding: 6px 10px;
  cursor: pointer;
  max-width: 90%;
}
.dark .live-bubble-tool {
  background: var(--bg-surface, #1e293b);
  border-color: var(--border-default, #334155);
  color: #94a3b8;
}
.live-tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
}
.live-tool-icon { display: flex; color: #64748b; flex-shrink: 0; }
.dark .live-tool-icon { color: #94a3b8; }
.live-tool-name { font-family: monospace; font-size: 11px; font-weight: 500; }
.live-tool-status-badge { font-size: 9px; padding: 1px 5px; border-radius: 6px; font-weight: 500; }
.live-tool-chevron {
  margin-left: auto;
  color: #94a3b8;
  transition: transform 0.15s;
  flex-shrink: 0;
}
.live-tool-chevron.expanded { transform: rotate(180deg); }

.live-tool-details {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(0,0,0,0.06);
}
.dark .live-tool-details { border-top-color: rgba(255,255,255,0.08); }
.live-tool-section { margin-bottom: 4px; }
.live-tool-label { font-size: 10px; font-weight: 600; color: #64748b; margin-bottom: 2px; }
.dark .live-tool-label { color: #94a3b8; }
.live-tool-pre {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--bg-surface, #1e293b);
  color: #94a3b8;
  font-size: 11px;
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}
.dark .live-tool-pre { background: #0f172a; }

/* Thinking bubble */
.live-bubble-thinking {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: #94a3b8;
  font-size: 12px;
  padding: 4px 8px;
}
.live-thinking-icon { display: flex; color: #64748b; }
.live-thinking-text { font-style: italic; }
.live-thinking-model { font-family: monospace; font-size: 10px; color: #64748b; margin-left: 4px; }
.dark .live-thinking-model { color: #475569; }

.live-bubble-thinking-active {
  background: rgba(59, 130, 246, 0.06);
  color: #3b82f6;
  padding: 8px 14px;
  border-radius: 12px;
  font-size: 13px;
}
.dark .live-bubble-thinking-active {
  background: rgba(59, 130, 246, 0.1);
  color: #60a5fa;
}
.live-thinking-anim { font-style: italic; }

/* Node event */
.live-bubble-node {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: #94a3b8;
  font-size: 11px;
  padding: 2px 8px;
}
.live-node-label { font-family: monospace; font-weight: 500; color: #64748b; }
.dark .live-node-label { color: #94a3b8; }
.live-node-data { font-size: 10px; color: #94a3b8; }

/* Lifecycle badge */
.live-lifecycle-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 3px 10px;
  border-radius: 10px;
}
.lifecycle-started { background: rgba(59, 130, 246, 0.08); color: #3b82f6; }
.lifecycle-completed { background: rgba(34, 197, 94, 0.08); color: #22c55e; }
.dark .lifecycle-started { background: rgba(59, 130, 246, 0.12); color: #60a5fa; }
.dark .lifecycle-completed { background: rgba(34, 197, 94, 0.12); color: #4ade80; }
.live-lifecycle-dur { font-family: monospace; font-size: 10px; }
</style>
