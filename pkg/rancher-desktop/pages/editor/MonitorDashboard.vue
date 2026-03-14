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
        <p class="empty-msg text-ok" style="font-size: var(--fs-body); font-weight: var(--weight-medium);">No errors found</p>
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
  background: var(--bg-primary);
  color: var(--text-secondary);
}
.monitor-dashboard.dark {
  background: var(--bg-primary);
  color: var(--text-muted);
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
  font-size: var(--fs-heading);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.refresh-btn {
  padding: 6px 14px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: var(--fs-code);
  font-weight: var(--weight-medium);
}
.refresh-btn:hover { background: var(--bg-hover); }
.dark .refresh-btn { border-color: var(--border-default); }
.dark .refresh-btn:hover { background: var(--bg-hover); }

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
.health-ok { border-color: var(--border-success); background: var(--bg-success); }
.health-err { border-color: var(--border-error); background: var(--bg-error); }
.dark .health-ok { border-color: var(--border-success); background: var(--bg-success); }
.dark .health-err { border-color: var(--border-error); background: var(--bg-error); }

.health-card-inner { display: flex; align-items: center; gap: 10px; }
.health-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.dot-ok { background: var(--text-success); }
.dot-err { background: var(--text-error); }
.dot-warn { background: var(--text-warning); }
.health-name { font-size: var(--fs-code); font-weight: var(--weight-semibold); color: var(--text-primary); }
.health-detail { font-size: var(--fs-body-sm); color: var(--text-secondary); margin-top: 2px; }
.dark .health-detail { color: var(--text-muted); }

/* ── Stat Cards ── */
.stat-card {
  border-radius: 10px;
  border: 1px solid var(--border-default);
  background: var(--bg-primary);
  padding: 14px;
}
.dark .stat-card { border-color: var(--border-default); background: var(--bg-surface); }
.stat-label { font-size: var(--fs-caption); font-weight: var(--weight-semibold); text-transform: uppercase; color: var(--text-secondary); letter-spacing: var(--tracking-wide); }
.dark .stat-label { color: var(--text-muted); }
.stat-value { font-size: var(--fs-heading); font-weight: var(--weight-semibold); color: var(--text-primary); margin-top: 4px; }
.stat-value-sm { font-size: var(--fs-body); }
.stat-value-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }

/* ── Panels ── */
.panel {
  border-radius: 10px;
  border: 1px solid var(--border-default);
  background: var(--bg-primary);
  padding: 18px;
  margin-bottom: 20px;
}
.dark .panel { border-color: var(--border-default); background: var(--bg-surface); }

.panel-title {
  font-size: var(--fs-heading);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  margin-bottom: 14px;
}

.empty-panel { text-align: center; padding: 40px 18px; }

/* ── Tables ── */
.table-wrap { overflow-x: auto; }
.data-table { width: 100%; font-size: var(--fs-code); border-collapse: collapse; }
.data-table th { text-align: left; font-weight: var(--weight-medium); color: var(--text-secondary); padding: 8px 10px; border-bottom: 1px solid var(--border-default); }
.dark .data-table th { color: var(--text-muted); border-color: var(--border-default); }
.data-table td { padding: 8px 10px; border-bottom: 1px solid var(--border-default); }
.dark .data-table td { border-color: var(--border-default); }
.data-table tr:hover { background: var(--bg-hover); }

.cell-name { font-weight: var(--weight-medium); color: var(--text-primary); }
.cell-mono { font-family: var(--font-mono); font-size: var(--fs-body-sm); color: var(--text-secondary); }
.dark .cell-mono { color: var(--text-muted); }
.cell-detail { font-size: var(--fs-code); color: var(--text-secondary); }
.dark .cell-detail { color: var(--text-muted); }
.cell-nowrap { white-space: nowrap; }
.cell-truncate { max-width: 350px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── Badges ── */
.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-medium);
}
.badge-ok { background: var(--bg-success); color: var(--text-success); }
.badge-err { background: var(--bg-error); color: var(--text-error); }
.badge-info { background: var(--bg-info); color: var(--text-info); }
.badge-warn { background: var(--bg-warning); color: var(--text-warning); }
.badge-purple { background: var(--bg-accent); color: var(--text-accent); }
.badge-neutral { background: var(--bg-surface); color: var(--text-secondary); }
.dark .badge-ok { background: var(--bg-success); color: var(--text-success); }
.dark .badge-err { background: var(--bg-error); color: var(--text-error); }
.dark .badge-info { background: var(--bg-info); color: var(--text-info); }
.dark .badge-warn { background: var(--bg-warning); color: var(--text-warning); }
.dark .badge-purple { background: var(--bg-accent); color: var(--text-accent); }
.dark .badge-neutral { background: var(--bg-surface); color: var(--text-muted); }

/* ── WebSocket ── */
.ws-list { display: flex; flex-direction: column; gap: 10px; }
.ws-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--bg-surface);
}
.dark .ws-row { background: var(--bg-primary); }
.ws-channel { font-family: var(--font-mono); font-size: var(--fs-code); font-weight: var(--weight-medium); color: var(--text-primary); }
.ws-subs { font-size: var(--fs-body-sm); color: var(--text-secondary); margin-top: 2px; }
.dark .ws-subs { color: var(--text-muted); }
.ws-status { display: flex; align-items: center; gap: 8px; font-size: var(--fs-code); }
.ws-dot { width: 8px; height: 8px; border-radius: 50%; }

/* ── Events ── */
.event-scroll { max-height: 600px; overflow-y: auto; }
.event-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: var(--fs-code);
}
.row-err { background: var(--bg-error); }
.row-ok { background: var(--bg-success); }
.row-info { background: var(--bg-info); }
.row-warn { background: var(--bg-warning); }
.dark .row-err { background: var(--bg-error); }
.dark .row-ok { background: var(--bg-success); }
.dark .row-info { background: var(--bg-info); }
.dark .row-warn { background: var(--bg-warning); }

.event-time { flex-shrink: 0; font-family: var(--font-mono); font-size: var(--fs-body-sm); color: var(--text-muted); }
.event-badge { flex-shrink: 0; padding: 1px 6px; border-radius: 4px; font-size: var(--fs-body-sm); font-weight: var(--weight-medium); }
.event-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.event-dur { flex-shrink: 0; font-size: var(--fs-body-sm); color: var(--text-muted); }

/* ── Conversations ── */
.filter-bar { display: flex; gap: 10px; margin-bottom: 16px; }
.filter-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: var(--fs-code);
}
.filter-input::placeholder { color: var(--text-muted); }
.dark .filter-input { border-color: var(--border-default); background: var(--bg-surface); color: var(--text-primary); }
.dark .filter-input::placeholder { color: var(--text-secondary); }
.filter-input:focus { outline: none; border-color: var(--accent-primary); }

.filter-select {
  padding: 8px 12px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: var(--fs-code);
}
.dark .filter-select { border-color: var(--border-default); background: var(--bg-surface); color: var(--text-primary); }

.conv-list { display: flex; flex-direction: column; gap: 8px; }
.conv-card {
  border-radius: 10px;
  border: 1px solid var(--border-default);
  background: var(--bg-primary);
  cursor: pointer;
  transition: border-color 0.15s;
}
.conv-card:hover { border-color: var(--accent-primary); }
.dark .conv-card { border-color: var(--border-default); background: var(--bg-surface); }
.dark .conv-card:hover { border-color: var(--accent-primary); }

.conv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
}
.conv-left { display: flex; align-items: center; gap: 10px; }
.conv-right { display: flex; align-items: center; gap: 10px; font-size: var(--fs-code); }
.conv-type-badge { padding: 2px 8px; border-radius: 10px; font-size: var(--fs-body-sm); font-weight: var(--weight-medium); }
.conv-name { font-weight: var(--weight-medium); font-size: var(--fs-body); color: var(--text-primary); }
.conv-channel { font-family: var(--font-mono); font-size: var(--fs-body-sm); color: var(--text-muted); }
.conv-time { color: var(--text-muted); }
.conv-chevron { color: var(--text-muted); transition: transform 0.15s; flex-shrink: 0; }
.conv-chevron.open { transform: rotate(180deg); }

.conv-events {
  border-top: 1px solid var(--border-default);
  padding: 12px 16px;
}
.dark .conv-events { border-color: var(--border-default); }
.conv-event-scroll { max-height: 400px; overflow-y: auto; }
.conv-event-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: var(--fs-code);
}

/* ── Text colors ── */
.text-ok { color: var(--text-success); }
.text-err { color: var(--text-error); }
.text-info { color: var(--text-info); }
.text-warn { color: var(--text-warning); }
.text-warn-strong { font-weight: var(--weight-medium); color: var(--text-warning); }
.msg-role { font-weight: var(--weight-medium); }
.empty-msg { font-size: var(--fs-code); color: var(--text-muted); }

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
.btn-active { background: var(--bg-info); border-color: var(--accent-primary); color: var(--text-info); }
.dark .btn-active { background: var(--bg-info); border-color: var(--accent-primary); color: var(--text-info); }

.ws-msg-scroll { flex: 1; overflow-y: auto; max-height: 200px; }
.ws-msg-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: var(--fs-code);
}
.ws-msg-type { flex-shrink: 0; font-weight: var(--weight-medium); font-family: var(--font-mono); font-size: var(--fs-body-sm); color: var(--text-primary); }
.ws-msg-data { font-family: var(--font-mono); font-size: var(--fs-body-sm); word-break: break-all; }

.clickable { cursor: pointer; transition: box-shadow 0.15s, background 0.15s; }
.clickable:hover { box-shadow: 0 0 0 2px var(--border-focus); }
tr.clickable:hover { box-shadow: none; background: var(--bg-hover); }
.dark tr.clickable:hover { background: var(--bg-hover); }

/* ── Live Conversations ── */
.live-layout { padding: 0 !important; display: flex; flex-direction: column; height: 100%; }
.live-layout .dashboard-header { padding: 16px 24px 12px; flex-shrink: 0; }

.live-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-error);
  letter-spacing: var(--tracking-wider);
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-error);
  animation: livePulse 1.5s ease-in-out infinite;
}
@keyframes livePulse {
  0%, 100% { opacity: 1; box-shadow: none; }
  50% { opacity: 0.7; box-shadow: none; }
}

.live-split {
  flex: 1;
  display: flex;
  min-height: 0;
  border-top: 1px solid var(--border-default);
}
.dark .live-split { border-color: var(--border-default); }

/* Sessions sidebar */
.live-sessions {
  width: 280px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-default);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dark .live-sessions { border-color: var(--border-default); }

.live-sessions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.dark .live-sessions-header { border-color: var(--border-default); }
.live-sessions-title { font-size: var(--fs-body-sm); font-weight: var(--weight-semibold); text-transform: uppercase; letter-spacing: var(--tracking-wide); color: var(--text-secondary); }
.dark .live-sessions-title { color: var(--text-muted); }
.live-sessions-count { font-size: var(--fs-caption); color: var(--text-muted); }

.live-session-item {
  padding: 10px 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-default);
  transition: background 0.1s;
}
.live-session-item:hover { background: var(--bg-hover); }
.dark .live-session-item { border-color: var(--border-default); }
.dark .live-session-item:hover { background: var(--bg-hover); }
.live-session-item.selected { background: var(--bg-info); border-left: 3px solid var(--accent-primary); }
.dark .live-session-item.selected { background: var(--bg-info); }
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
.dot-running { background: var(--text-info); animation: livePulse 1.5s ease-in-out infinite; }
.live-session-name {
  font-size: var(--fs-code);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-session-meta {
  display: flex;
  gap: 8px;
  margin-top: 4px;
  padding-left: 16px;
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
}
.live-session-channel { font-family: var(--font-mono); }
.live-session-agent { font-family: var(--font-mono); }
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
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.dark .live-thread-header { border-color: var(--border-default); }
.live-thread-info { display: flex; flex-direction: column; gap: 2px; }
.live-thread-name { font-size: var(--fs-body); font-weight: var(--weight-semibold); color: var(--text-primary); }
.live-thread-detail { font-size: var(--fs-body-sm); color: var(--text-muted); }

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
.live-msg-time { font-size: var(--fs-caption); color: var(--text-muted); margin-top: 2px; padding: 0 4px; }

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
  font-size: var(--fs-code);
  line-height: 1.5;
  word-break: break-word;
}

.live-bubble-user {
  background: var(--bg-info);
  color: var(--text-info);
  border-bottom-right-radius: 4px;
}
.dark .live-bubble-user {
  background: var(--bg-info);
  color: var(--text-primary);
}

.live-bubble-assistant {
  background: var(--bg-surface);
  color: var(--text-secondary);
  border-bottom-left-radius: 4px;
}
.dark .live-bubble-assistant {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.live-bubble-system {
  background: var(--bg-warning);
  color: var(--text-warning);
  font-size: var(--fs-code);
  max-width: 90%;
  border-radius: 8px;
}
.dark .live-bubble-system {
  background: var(--bg-warning);
  color: var(--text-warning);
}

.live-bubble-content { white-space: pre-wrap; }

.live-bubble .prose-content { white-space: normal; }
.live-bubble .prose-content :deep(p) { margin: 0 0 0.5em; }
.live-bubble .prose-content :deep(p:last-child) { margin-bottom: 0; }
.live-bubble .prose-content :deep(pre) {
  background: var(--bg-surface);
  color: var(--text-primary);
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: var(--fs-code);
  margin: 4px 0;
}
.dark .live-bubble .prose-content :deep(pre) { background: var(--bg-primary); }
.live-bubble .prose-content :deep(code) { font-size: var(--fs-code); font-family: var(--font-mono); }
.live-bubble .prose-content :deep(code:not(pre code)) { background: var(--bg-hover); padding: 1px 4px; border-radius: 3px; }

/* Tool call bubble */
.live-bubble-tool {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-size: var(--fs-code);
  padding: 6px 10px;
  cursor: pointer;
  max-width: 90%;
}
.dark .live-bubble-tool {
  background: var(--bg-surface);
  border-color: var(--border-default);
  color: var(--text-muted);
}
.live-tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
}
.live-tool-icon { display: flex; color: var(--text-secondary); flex-shrink: 0; }
.dark .live-tool-icon { color: var(--text-muted); }
.live-tool-name { font-family: var(--font-mono); font-size: var(--fs-body-sm); font-weight: var(--weight-medium); }
.live-tool-status-badge { font-size: var(--fs-caption); padding: 1px 5px; border-radius: 6px; font-weight: var(--weight-medium); }
.live-tool-chevron {
  margin-left: auto;
  color: var(--text-muted);
  transition: transform 0.15s;
  flex-shrink: 0;
}
.live-tool-chevron.expanded { transform: rotate(180deg); }

.live-tool-details {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border-default);
}
.live-tool-section { margin-bottom: 4px; }
.live-tool-label { font-size: var(--fs-caption); font-weight: var(--weight-semibold); color: var(--text-secondary); margin-bottom: 2px; }
.dark .live-tool-label { color: var(--text-muted); }
.live-tool-pre {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-muted);
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}
.dark .live-tool-pre { background: var(--bg-primary); }

/* Thinking bubble */
.live-bubble-thinking {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--fs-code);
  padding: 4px 8px;
}
.live-thinking-icon { display: flex; color: var(--text-secondary); }
.live-thinking-text { font-style: italic; }
.live-thinking-model { font-family: var(--font-mono); font-size: var(--fs-caption); color: var(--text-secondary); margin-left: 4px; }
.dark .live-thinking-model { color: var(--text-muted); }

.live-bubble-thinking-active {
  background: var(--bg-info);
  color: var(--text-info);
  padding: 8px 14px;
  border-radius: 12px;
  font-size: var(--fs-code);
}
.dark .live-bubble-thinking-active {
  background: var(--bg-info);
  color: var(--text-info);
}
.live-thinking-anim { font-style: italic; }

/* Node event */
.live-bubble-node {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--fs-body-sm);
  padding: 2px 8px;
}
.live-node-label { font-family: var(--font-mono); font-weight: var(--weight-medium); color: var(--text-secondary); }
.dark .live-node-label { color: var(--text-muted); }
.live-node-data { font-size: var(--fs-caption); color: var(--text-muted); }

/* Lifecycle badge */
.live-lifecycle-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-caption);
  font-weight: var(--weight-medium);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  padding: 3px 10px;
  border-radius: 10px;
}
.lifecycle-started { background: var(--bg-info); color: var(--text-info); }
.lifecycle-completed { background: var(--bg-success); color: var(--text-success); }
.dark .lifecycle-started { background: var(--bg-info); color: var(--text-info); }
.dark .lifecycle-completed { background: var(--bg-success); color: var(--text-success); }
.live-lifecycle-dur { font-family: var(--font-mono); font-size: var(--fs-caption); }
</style>
