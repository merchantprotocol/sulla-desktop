<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="studio-page">
    <StudioTopbar
      v-model:search="search"
      :crumbs="selected ? ['Live Agents', selected.label] : ['Live Agents']"
      search-placeholder="Search live agents"
      @crumb="selected = null"
    />
    <div class="studio-content">
      <template v-if="selected">
        <button
          class="back"
          type="button"
          @click="selected = null"
        >
          ‹ Live Agents
        </button>
        <div class="card hero">
          <span class="fi purple big">◉</span><div>
            <h1>{{ selected.label }}</h1><p>{{ selected.lastCheckinSummary || selected.stateReason || selected.state }}</p><div class="meta">
              <span
                class="st"
                :class="statusClass(selected.state)"
                :title="selected.stateReason || undefined"
              ><i />{{ statusLabel(selected) }} · {{ elapsed(selected.startedAt) }}</span><span>{{ selected.agentId || 'Agent' }}</span>
            </div>
          </div><div class="acts">
            <button
              v-if="selected.canOpen"
              class="btn"
              type="button"
              @click="openRow(selected)"
            >
              Open
            </button><button
              v-if="selected.canStop"
              class="btn danger"
              type="button"
              :disabled="isPending('stop', selected)"
              @click="stopTarget = selected"
            >
              ■ Stop
            </button>
          </div>
        </div>
        <div class="dgrid">
          <div class="card box">
            <h2>Activity</h2><div
              v-if="detailLoading"
              class="empty"
            >
              Loading activity…
            </div><div
              v-else-if="!detail?.entries.length"
              class="empty"
            >
              <b>No recorded activity</b>This run has not written conversation events yet.
            </div><div
              v-else
              class="tl"
            >
              <div
                v-for="(entry, index) in detail.entries"
                :key="index"
                class="ev"
                :class="{ tool: entry.kind === 'tool', you: entry.kind === 'user' }"
              >
                <div class="who">
                  {{ entryWho(entry) }} · {{ clock(entry.ts) }}
                </div><div class="msg">
                  {{ entry.text }}
                </div>
              </div>
            </div><form
              v-if="selected.canMessage"
              class="composer"
              @submit.prevent="sendMessage(selected)"
            >
              <input
                v-model="message"
                placeholder="Message this agent…"
                aria-label="Message this agent"
              ><button
                class="btn pri"
                type="submit"
                :disabled="isPending('message', selected) || !message.trim()"
              >
                {{ isPending('message', selected) ? 'Sending…' : 'Send' }}
              </button>
            </form><p
              v-if="actionError"
              class="error-text"
            >
              {{ actionError }}
            </p>
          </div><aside class="card side">
            <h3>Run</h3><div class="kv">
              <span>Agent</span><b>{{ selected.agentId || 'Agent' }}</b>
            </div><div class="kv">
              <span>Started</span><b>{{ when(selected.startedAt) }}</b>
            </div><div class="kv">
              <span>Last check-in</span><b>{{ age(selected.lastCheckinAt) }}</b>
            </div>
          </aside>
        </div>
      </template>
      <template v-else>
        <div class="tb">
          <h1>Live Agents</h1><span>Every agent running on this desktop right now, grouped by root chat.</span><div class="acts">
            <span class="st ok"><i />streaming · updated {{ age(client.snapshot.value.generatedAt) }}</span>
          </div>
        </div>
        <div class="stats">
          <div class="card stat">
            <div class="lbl">
              <span class="dot success" />Agents live
            </div><b>{{ liveCount }}</b><small>across {{ groups.length }} root {{ groups.length === 1 ? 'chat' : 'chats' }}</small>
          </div><div class="card stat">
            <div class="lbl">
              <span class="dot accent" />Chats
            </div><b>{{ groups.length }}</b><small>full descendant trees</small>
          </div><div class="card stat">
            <div class="lbl">
              <span class="dot workflow" />Parked
            </div><b>{{ parkedCount }}</b><small>waiting on live children</small>
          </div><div class="card stat">
            <div class="lbl">
              <span class="dot warning" />Needs attention
            </div><b>{{ attentionCount }}</b><small>{{ attentionCount ? 'quiet, blocked, failed, or lost' : 'Nothing needs attention' }}</small>
          </div>
        </div>
        <div
          v-if="!filteredGroups.length"
          class="card empty"
        >
          <b>{{ search ? 'No matching agents' : 'Nothing is live right now' }}</b>{{ search ? 'Try another search.' : 'Agent runs will appear here.' }}
        </div>
        <div
          v-for="group in filteredGroups"
          :key="group.rootThreadId"
          class="card group"
        >
          <div class="group-head">
            <span class="fi blue">◉</span><div><b>{{ groupName(group.tree) }}</b><small> · root chat · {{ elapsed(group.tree[0]?.row.startedAt || null) }}</small></div>
          </div><div
            v-for="node in flatten(group.tree)"
            :key="node.row.key"
            class="agent-row click"
            :class="{ 'is-done': node.row.state === 'done' }"
            :style="{ paddingLeft: `${14 + node.depth * 20}px` }"
            @click="selectRow(node.row)"
          >
            <span class="tree">{{ node.row.depth ? '└' : '•' }}</span><div><b>{{ node.row.label }}</b><small>{{ node.row.lastCheckinSummary || node.row.stateReason || node.row.agentId }}</small></div><span
              class="st"
              :class="statusClass(node.row.state)"
              :title="node.row.stateReason || undefined"
            ><i />{{ statusLabel(node.row) }}</span><span class="mono muted">{{ elapsed(node.row.startedAt) }}</span><div class="row-actions">
              <button
                v-if="node.row.canOpen"
                class="btn sm"
                type="button"
                @click.stop="openRow(node.row)"
              >
                Open
              </button><button
                v-if="node.row.canMessage"
                class="btn sm"
                type="button"
                :disabled="isPending('message', node.row)"
                @click.stop="messageTarget = node.row"
              >
                Message
              </button><button
                v-if="node.row.canStop"
                class="btn sm danger"
                type="button"
                :disabled="isPending('stop', node.row)"
                @click.stop="stopTarget = node.row"
              >
                Stop
              </button>
            </div>
          </div>
        </div>
      </template>
    </div>
    <div
      v-if="messageTarget"
      class="overlay"
      @click.self="messageTarget = null"
    >
      <form
        class="card modal"
        @submit.prevent="sendMessage(messageTarget)"
      >
        <h2>Message {{ messageTarget.label }}</h2><textarea
          v-model="message"
          rows="4"
          placeholder="What should this agent know?"
        /><p
          v-if="actionError"
          class="error-text"
        >
          {{ actionError }}
        </p><div class="modal-actions">
          <button
            class="btn"
            type="button"
            @click="messageTarget = null"
          >
            Cancel
          </button><button
            class="btn pri"
            type="submit"
            :disabled="isPending('message', messageTarget) || !message.trim()"
          >
            {{ isPending('message', messageTarget) ? 'Sending…' : 'Send message' }}
          </button>
        </div>
      </form>
    </div>
    <div
      v-if="stopTarget"
      class="overlay"
      @click.self="stopTarget = null"
    >
      <div class="card modal">
        <h2>Stop {{ stopTarget.label }}?</h2><p>The current tool call may finish before the run stops.</p><p
          v-if="actionError"
          class="error-text"
        >
          {{ actionError }}
        </p><div class="modal-actions">
          <button
            class="btn"
            type="button"
            @click="stopTarget = null"
          >
            Cancel
          </button><button
            class="btn danger"
            type="button"
            :disabled="isPending('stop', stopTarget)"
            @click="stopRun"
          >
            {{ isPending('stop', stopTarget) ? 'Stopping…' : 'Stop run' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue';

import StudioTopbar from './StudioTopbar.vue';

import type { AgentConversationDetail } from '@pkg/main/agentsIpc';
import { AgentActionController } from '@pkg/services/agentState/AgentActionController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentTreeBuilder, type AgentTreeNode } from '@pkg/services/agentState/AgentTreeBuilder';
import type { AgentStateRow, AgentRowState } from '@pkg/shared/agentState/AgentStateSnapshot';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const client = inject(AGENT_STATE_CLIENT_KEY);
if (!client) throw new Error('AgentStateClient is not provided');
const actions = new AgentActionController(ipcRenderer as any, client);
const now = ref(Date.now()); const search = ref(''); const selected = ref<AgentStateRow | null>(null); const detail = ref<AgentConversationDetail | null>(null); const detailLoading = ref(false); const messageTarget = ref<AgentStateRow | null>(null); const stopTarget = ref<AgentStateRow | null>(null); const message = ref(''); const actionError = ref(''); const pending = ref(new Set<string>()); let clockTimer: ReturnType<typeof setInterval> | undefined;
const builder = computed(() => new AgentTreeBuilder(client.snapshot.value.rows));
const groups = computed(() => builder.value.groups());
const filteredGroups = computed(() => { const q = search.value.trim().toLowerCase(); if (!q) return groups.value; return groups.value.flatMap(group => { const matching = flatten(group.tree).filter(node => [node.row.label, node.row.agentId, node.row.lastCheckinSummary].some(value => value?.toLowerCase().includes(q))); return matching.length ? [{ ...group, tree: matching.map(node => ({ ...node, children: [] })) }] : [] }) });
const liveStates = new Set<AgentRowState>(['queued', 'working', 'parked', 'quiet', 'blocked']);
const liveCount = computed(() => client.snapshot.value.rows.filter(row => liveStates.has(row.state)).length); const parkedCount = computed(() => client.snapshot.value.rows.filter(row => row.state === 'parked').length); const attentionCount = computed(() => client.snapshot.value.rows.filter(row => ['quiet', 'blocked', 'failed', 'lost'].includes(row.state)).length);
function flatten(tree: readonly AgentTreeNode[]): AgentTreeNode[] { return builder.value.flatten(tree) }
function groupName(tree: readonly AgentTreeNode[]): string { return tree[0]?.row.label || 'Agent run' }
function pendingKey(action: 'message' | 'stop', row: AgentStateRow): string { return `${ action }:${ action === 'stop' ? row.jobId : row.key }` }
function isPending(action: 'message' | 'stop', row: AgentStateRow): boolean { return pending.value.has(pendingKey(action, row)) }
async function loadDetail(): Promise<void> { if (!selected.value?.threadId) { detail.value = null; return } detailLoading.value = true; try { detail.value = await ipcRenderer.invoke('agents:conversation', selected.value.threadId) } catch { detail.value = null } finally { detailLoading.value = false } }
function selectRow(row: AgentStateRow): void { selected.value = row; actionError.value = ''; loadDetail().catch(() => undefined) }
async function sendMessage(row: AgentStateRow): Promise<void> { if (!message.value.trim() || !actions.canMessage(row)) return; const key = pendingKey('message', row); pending.value = new Set(pending.value).add(key); actionError.value = ''; try { const result = await actions.message(row, message.value.trim()); if (result.stale) { messageTarget.value = null; return } if (!result.ok) { actionError.value = result.error || 'The message could not be delivered.'; return } message.value = ''; messageTarget.value = null } finally { const next = new Set(pending.value); next.delete(key); pending.value = next } }
async function stopRun(): Promise<void> { const row = stopTarget.value; if (!row || !actions.canStop(row)) return; const key = pendingKey('stop', row); pending.value = new Set(pending.value).add(key); actionError.value = ''; try { const result = await actions.stop(row); if (result.stale) { stopTarget.value = null; selected.value = null; return } if (!result.ok) { actionError.value = result.error || 'The run could not be stopped.'; return } stopTarget.value = null; selected.value = null } finally { const next = new Set(pending.value); next.delete(key); pending.value = next } }
async function openRow(row: AgentStateRow): Promise<void> { if (row.canOpen && row.rootThreadId) await ipcRenderer.invoke('agents:open-job-in-tab' as any, row.jobId, row.rootThreadId, row.taskIndex); }
function statusClass(state: AgentRowState): string { return ['working', 'queued', 'parked', 'done'].includes(state) ? 'run' : ['failed', 'blocked', 'lost'].includes(state) ? 'bad' : 'warn' }
function statusLabel(row: AgentStateRow): string { if (row.state === 'parked') return `Parked · waiting on ${ row.waitingOnChildren }`; if (row.state === 'quiet') return `Quiet · ${ age(row.lastCheckinAt) }`; return row.state.charAt(0).toUpperCase() + row.state.slice(1) }
function elapsed(value: string | null): string { if (!value) return 'not started'; const seconds = Math.max(0, Math.floor((now.value - Date.parse(value)) / 1000)); if (seconds < 60) return `${ seconds }s`; if (seconds < 3600) return `${ Math.floor(seconds / 60) } min`; return `${ Math.floor(seconds / 3600) }h ${ Math.floor(seconds % 3600 / 60) }m` }
function age(value: string | null): string { return value ? `${ elapsed(value) } ago` : 'not recorded' } function when(value: string | null): string { return value ? new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'not recorded' } function clock(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) } function entryWho(entry: AgentConversationDetail['entries'][number]): string { if (entry.kind === 'user') return 'You'; if (entry.kind === 'tool') return entry.toolName || 'Tool'; if (entry.kind === 'event') return 'Run'; return selected.value?.label || 'Agent' }
watch(() => selected.value?.threadId, () => loadDetail().catch(() => undefined));
watch(() => client.snapshot.value, snapshot => {
  const current = new Map(snapshot.rows.map(row => [row.key, row]));
  if (selected.value) selected.value = current.get(selected.value.key) ?? null;
  if (messageTarget.value) messageTarget.value = current.get(messageTarget.value.key) ?? null;
  if (stopTarget.value) stopTarget.value = current.get(stopTarget.value.key) ?? null;
});
onMounted(() => { clockTimer = setInterval(() => { now.value = Date.now() }, 1000) }); onUnmounted(() => { if (clockTimer) clearInterval(clockTimer); });
</script>

<style scoped lang="scss">
@import '@pkg/assets/styles/studio-ui.scss';
.group{margin-bottom:12px}.group-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--uc-line)}.group-head small,.muted{color:var(--uc-dim)}.group-head .acts{margin-left:auto}.agent-row{display:grid;grid-template-columns:22px minmax(220px,1fr) 160px 90px auto;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--uc-line)}.agent-row:last-child{border-bottom:0}.agent-row.is-done{opacity:.72}.agent-row.click{cursor:pointer}.agent-row.click:hover{background:var(--uc-paper)}.agent-row b,.agent-row small{display:block}.agent-row small{margin-top:2px;color:var(--uc-dim)}.tree{color:var(--uc-dim)}.row-actions{display:flex;justify-content:flex-end;gap:6px}.dot.success{background:var(--uc-success)}.dot.accent{background:var(--uc-accent)}.dot.workflow{background:#7656d8}.dot.warning{background:#c47a00}.tl{margin:14px 0}.ev{padding:12px 0 12px 18px;border-left:2px solid var(--uc-accent-line)}.ev.tool{border-color:var(--uc-line-strong)}.ev.you{border-color:#7656d8}.who{margin-bottom:4px;color:var(--uc-dim);font-size:11px}.msg{color:var(--uc-muted);line-height:1.5;white-space:pre-wrap}.composer{display:flex;gap:8px;margin-top:18px}.composer input,.modal textarea{flex:1;padding:9px 11px;border:1px solid var(--uc-line-strong);border-radius:8px;background:var(--uc-card);color:var(--uc-text);font:inherit}.brief{padding:12px 16px!important}.overlay{position:absolute;inset:0;z-index:20;display:grid;place-items:center;padding:24px;background:color-mix(in srgb,#000 45%,transparent)}.modal{width:min(480px,100%);padding:20px}.modal h2{margin:0 0 8px}.modal textarea{width:100%;margin:12px 0;resize:vertical}.modal-actions{display:flex;justify-content:flex-end;gap:8px}.error-text{color:var(--uc-danger)!important}.hero>div:nth-child(2){min-width:0;flex:1}@media(max-width:900px){.agent-row{grid-template-columns:20px 1fr}.agent-row>.st,.agent-row>.mono,.row-actions{grid-column:2}.hero{flex-wrap:wrap}.hero .acts{width:100%;margin-left:82px}}
</style>
