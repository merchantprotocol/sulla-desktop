<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<template>
  <div class="cv-root">
    <aside class="cv-nav">
      <div class="cv-brand"><img :src="robotLogoUrl" alt="Sulla" /><span><b>Sulla</b><small>Conversations</small></span></div>
      <label class="cv-org-label">Organization
        <select v-model="activeOrg" :disabled="loading" @change="refresh">
          <option v-for="org in organizations" :key="org.orgId" :value="org.orgId">{{ org.name }}</option>
        </select>
      </label>
      <button class="cv-nav-item" :class="{ active: section === 'conversations' }" @click="section = 'conversations'"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/></svg>All conversations</button>
      <button class="cv-nav-item" :class="{ active: section === 'people' }" @click="section = 'people'"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8m2 3a6 6 0 0 1 4 6"/></svg>People <span class="cv-count">{{ people.length }}</span></button>
      <button class="cv-nav-item" @click="secretaryOpen = true; startSecretary()"><svg viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="14" rx="5"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8"/></svg>Start Secretary Mode</button>
      <div class="cv-nav-divider"></div>
      <p class="cv-note">Each organization has its own people and conversations. Switching never moves a message between organizations.</p>
      <div class="cv-nav-bottom"><span class="cv-presence-dot"></span><span>{{ loading ? 'Connecting…' : error ? 'Connection issue' : 'Connected' }}</span></div>
    </aside>

    <section class="cv-list">
      <header class="cv-list-head"><div class="cv-list-title"><h1>{{ section === 'people' ? 'People' : 'Conversations' }}</h1><button class="cv-icon-button" title="New message" :disabled="!people.length" @click="section = 'people'">+</button></div>
        <label class="cv-search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg><input v-model="query" :placeholder="`Search ${activeOrgName}`" /></label>
        <div class="cv-segments"><button :class="{ active: filter === 'all' }" @click="filter = 'all'">All</button><button :class="{ active: filter === 'people' }" @click="filter = 'people'">People</button><button :class="{ active: filter === 'agents' }" @click="filter = 'agents'">Agents</button></div>
      </header>
      <div class="cv-list-body">
        <template v-if="section === 'people'">
          <div class="cv-overline">Members · {{ people.length }}</div>
          <div class="cv-group-create"><span>{{ selectedPeople.length }} selected</span><button class="cv-primary" :disabled="selectedPeople.length < 2 || loading" @click="createGroup">Create group</button></div>
          <div v-for="person in visiblePeople" :key="person.userId" class="cv-row" role="button" tabindex="0" @click="openDirect(person)" @keydown.enter="openDirect(person)">
            <input v-model="selectedPeople" class="cv-select-person" type="checkbox" :value="person.userId" :aria-label="`Add ${person.displayName} to group`" @click.stop />
            <span class="cv-avatar" :class="presenceClass(person)">{{ initials(person.displayName) }}<i></i></span>
            <span class="cv-row-copy"><b>{{ person.displayName }}</b><small>{{ person.presence || 'Availability unknown' }}</small><small class="cv-agent-label">{{ person.agentName || `${person.displayName.split(' ')[0]}'s agent` }} · {{ person.agentHostOnline ? 'available' : 'will answer when their Desktop is back' }}</small></span>
            <span class="cv-row-action">Message</span>
          </div>
          <p v-if="!visiblePeople.length" class="cv-empty">No other organization members are available.</p>
        </template>
        <template v-else>
          <div v-if="visibleThreads.length" class="cv-thread-list">
            <button v-for="thread in visibleThreads" :key="thread.id" class="cv-row" :class="{ selected: selectedId === thread.id }" @click="selectedId = thread.id">
              <span class="cv-avatar" :class="thread.kind === 'agent_thread' ? 'agent' : ''">{{ initials(thread.title) }}<i></i></span>
              <span class="cv-row-copy"><b>{{ thread.title }}</b><small>{{ thread.kind === 'agent_thread' ? 'Agent thread' : thread.kind === 'group' ? 'Group conversation' : 'Direct message' }}</small><small class="cv-thread-preview">{{ thread.latest }}</small></span>
              <span v-if="thread.unread" class="cv-unread">{{ thread.unread }}</span>
            </button>
          </div>
          <div v-else-if="!loading" class="cv-empty-state"><div class="cv-empty-icon"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/></svg></div><b>No conversations yet</b><p>Conversations with people in {{ activeOrgName }} and threads where your agent talks to theirs will show up here.</p><button class="cv-primary" @click="section = 'people'">Find people</button></div>
        </template>
      </div>
    </section>

    <main class="cv-main">
      <template v-if="selectedThread">
        <header class="cv-thread-head"><span class="cv-avatar">{{ initials(selectedThread.title) }}</span><span><b>{{ selectedThread.title }}</b><small>{{ activeOrgName }} · {{ selectedThread.kind === 'agent_thread' ? 'Agents' : selectedThread.participantIds.length + ' participants' }}</small></span><div class="cv-thread-actions"><button class="cv-secondary" disabled title="Calls coming soon">Voice</button><button class="cv-secondary" disabled title="Calls coming soon">Video</button><button class="cv-secondary" @click="secretaryOpen = true">Secretary</button></div></header>
        <div class="cv-messages">
          <div v-for="message in selectedThread.messages" :key="message.messageId" class="cv-message" :class="{ mine: message.from.userId === userId }"><span class="cv-avatar small">{{ initials(senderName(message)) }}</span><div class="cv-message-body"><div class="cv-message-meta"><b>{{ senderName(message) }}</b><time>{{ formatTime(message.createdAt) }}</time></div><p>{{ message.body.text }}</p><div v-if="message.body.refs?.length" class="cv-ref-card">Shared item · available to conversation participants</div></div></div>
          <div v-if="!selectedThread.messages.length" class="cv-empty cv-message-empty">Start the conversation. Your messages stay within {{ activeOrgName }}.</div>
        </div>
        <form class="cv-composer" @submit.prevent="sendMessage"><textarea v-model="draft" :placeholder="`Message ${selectedThread.title}…`" :disabled="sending" @keydown.meta.enter.prevent="sendMessage" @keydown.ctrl.enter.prevent="sendMessage"></textarea><div class="cv-composer-foot"><small v-if="error" class="cv-error">{{ error }}</small><span v-else class="cv-composer-hint">Only participants can read this conversation</span><button class="cv-secondary" disabled title="Video messages coming soon">Video message</button><button class="cv-primary" type="submit" :disabled="sending || !draft.trim()">{{ sending ? 'Sending…' : 'Send' }}</button></div></form>
      </template>
      <div v-else-if="section === 'people'" class="cv-empty-state cv-main-empty"><div class="cv-empty-icon"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></div><b>Select a person to message</b><p>Start a private conversation with a member of {{ activeOrgName }}.</p></div>
      <div v-else class="cv-empty-state cv-main-empty"><div class="cv-empty-icon"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></div><b>Your conversations start here</b><p>Choose someone from People to send the first message.</p><button class="cv-primary" @click="section = 'people'">Browse people</button></div>
    </main>

    <aside class="cv-details" v-if="selectedThread"><h2>Conversation</h2><div class="cv-detail-card"><b>{{ selectedThread.title }}</b><small>{{ activeOrgName }}</small><hr/><small>{{ selectedThread.participantIds.length }} participants</small><p>Conversation messages are only visible to current participants.</p></div><div class="cv-detail-card cv-secretary-card"><div class="cv-detail-title"><svg viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="14" rx="5"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8"/></svg><b>Secretary notes</b></div><p>{{ savedNotes[selectedThread.id] ? `Saved to ${savedNotes[selectedThread.id]}` : 'Capture notes and action items for this conversation.' }}</p><button class="cv-secondary" @click="secretaryOpen = true">Start Secretary Mode</button></div><div class="cv-detail-card"><h3>Calls</h3><p>Voice and video calls aren't available yet.</p><button class="cv-secondary" disabled>Calls coming soon</button></div></aside>

    <div v-show="secretaryOpen" class="cv-modal" role="dialog" aria-modal="true" aria-label="Secretary Mode"><header><b>Secretary Mode</b><button class="cv-icon-button" aria-label="Close Secretary Mode" @click="secretaryOpen = false">×</button></header><div class="cv-secretary-body"><SecretaryMode :tab-id="tabId" :conversation-id="selectedThread?.id" @set-mode="$emit('set-mode', $event)" /></div></div>
    <div v-if="loading" class="cv-load-indicator">Loading organization conversations…</div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import SecretaryMode from '@pkg/pages/SecretaryMode.vue';
import { ConversationProjection, type ConversationMessageData, type ConversationThreadProjection } from './ConversationProjection';

type Org = { orgId: string; name: string; slug?: string; memberCount: number };
type Person = { userId: string; displayName: string; agentName?: string; presence?: string; agentHostOnline?: boolean; agents?: unknown[] };
type MessageData = ConversationMessageData;
type Thread = ConversationThreadProjection;
const props = defineProps<{ tabId: string }>();
defineEmits<{ (event: 'set-mode', mode: string): void }>();
const organizations = ref<Org[]>([]), activeOrg = ref(''), people = ref<Person[]>([]), messages = ref<MessageData[]>([]), localSent = ref<MessageData[]>([]);
const section = ref<'conversations' | 'people'>('conversations'), filter = ref('all'), query = ref(''), selectedId = ref(''), draft = ref(''), userId = ref(''), selectedPeople = ref<string[]>([]);
const loading = ref(false), sending = ref(false), secretaryOpen = ref(false), error = ref(''), emptyConversations = ref<Thread[]>([]), savedNotes = ref<Record<string, string>>({});
const projection = new ConversationProjection();
const robotLogoUrl = new URL('../../../../resources/icons/robot-512-nobg.png', import.meta.url).href;
const activeOrgName = computed(() => organizations.value.find(org => org.orgId === activeOrg.value)?.name ?? 'your organization');
const visiblePeople = computed(() => people.value.filter(person => person.userId !== userId.value && person.displayName.toLowerCase().includes(query.value.toLowerCase())));
const threads = computed<Thread[]>(() => {
  const loaded = projection.project([...messages.value, ...localSent.value], people.value, activeOrg.value, userId.value);
  const ids = new Set(loaded.map(thread => thread.id));
  return [...loaded, ...emptyConversations.value.filter(thread => !ids.has(thread.id))].sort((a, b) => (b.messages.at(-1)?.createdAt ?? '').localeCompare(a.messages.at(-1)?.createdAt ?? ''));
});
const visibleThreads = computed(() => threads.value.filter(thread => (filter.value === 'all' || filter.value === 'people' && thread.kind !== 'agent_thread' || filter.value === 'agents' && thread.kind === 'agent_thread') && `${thread.title} ${thread.latest}`.toLowerCase().includes(query.value.toLowerCase())));
const selectedThread = computed(() => threads.value.find(thread => thread.id === selectedId.value));

async function refresh(): Promise<void> {
  if (!activeOrg.value) return;
  const requestedOrg = activeOrg.value;
  loading.value = true; error.value = ''; selectedId.value = ''; people.value = []; messages.value = []; emptyConversations.value = [];
  localSent.value = [];
  try {
    const [directory, inbox, participant] = await Promise.all([
      ipcRenderer.invoke('org-conversations:directory', activeOrg.value),
      ipcRenderer.invoke('org-conversations:inbox', activeOrg.value),
      ipcRenderer.invoke('org-conversations:participant', activeOrg.value),
    ]);
    if (activeOrg.value !== requestedOrg) return;
    people.value = (directory.directory.people as Person[]).map((person: any) => ({ ...person, userId: person.userId ?? person.id, displayName: person.displayName ?? person.name ?? person.userId ?? person.id }));
    messages.value = inbox.messages as MessageData[]; userId.value = participant.userId;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not load organization conversations'; }
  finally { loading.value = false; }
}
async function initialize(): Promise<void> {
  loading.value = true;
  try {
    organizations.value = [...await ipcRenderer.invoke('org-conversations:organizations')];
    if (!activeOrg.value && organizations.value.length) activeOrg.value = organizations.value[0].orgId;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not load your organizations'; }
  finally { loading.value = false; }
  await refresh();
}
async function openDirect(person: Person): Promise<void> {
  error.value = '';
  try {
    const humanId = userId.value || (await ipcRenderer.invoke('org-conversations:participant', activeOrg.value)).userId;
    const participantIds = [humanId, person.userId];
    const result = await ipcRenderer.invoke('org-conversations:start', { orgId: activeOrg.value, participantUserIds: participantIds, kind: 'direct' });
    const org = activeOrg.value;
    section.value = 'conversations'; await refresh();
    if (activeOrg.value !== org) return;
    emptyConversations.value = [...emptyConversations.value.filter(thread => thread.id !== result.conversationId), { id: result.conversationId, kind: 'direct', title: person.displayName, participantIds, messages: [], latest: '', unread: 0 }];
    selectedId.value = result.conversationId;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not start conversation'; }
}
async function createGroup(): Promise<void> {
  if (selectedPeople.value.length < 2) return;
  error.value = '';
  try {
    const humanId = userId.value || (await ipcRenderer.invoke('org-conversations:participant', activeOrg.value)).userId;
    const participantIds = [humanId, ...new Set(selectedPeople.value)];
    const result = await ipcRenderer.invoke('org-conversations:start', { orgId: activeOrg.value, participantUserIds: participantIds, kind: 'group' });
    const org = activeOrg.value;
    section.value = 'conversations'; selectedPeople.value = []; await refresh();
    if (activeOrg.value !== org) return;
    const title = participantIds.slice(1).map(id => people.value.find(person => person.userId === id)?.displayName ?? 'Member').join(', ');
    emptyConversations.value = [...emptyConversations.value, { id: result.conversationId, kind: 'group', title, participantIds, messages: [], latest: '', unread: 0 }];
    selectedId.value = result.conversationId;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not start group conversation'; }
}
async function sendMessage(): Promise<void> {
  if (!selectedThread.value || !draft.value.trim() || sending.value) return;
  const conversationId = selectedThread.value.id;
  sending.value = true; error.value = '';
  try {
    const sentText = draft.value.trim();
    const result = await ipcRenderer.invoke('org-conversations:send', { orgId: activeOrg.value, conversationId, toUserIds: selectedThread.value.participantIds, text: sentText });
    localSent.value = [...localSent.value, result.message as MessageData];
    draft.value = ''; selectedId.value = conversationId;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Message was not sent'; }
  finally { sending.value = false; }
}
function startSecretary(): void { void nextTick(() => window.setTimeout(() => window.dispatchEvent(new CustomEvent('sulla:secretary-start', { detail: { tabId: props.tabId } })), 40)); }
function initials(label: string): string { return label.split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase() || '?'; }
function presenceClass(person: Person): string { return person.presence?.toLowerCase() === 'online' ? 'online' : 'offline'; }
function senderName(message: MessageData): string { return message.from.agentId ? `${people.value.find(person => person.userId === message.from.userId)?.displayName ?? 'Member'}’s agent` : message.from.userId === userId.value ? 'You' : people.value.find(person => person.userId === message.from.userId)?.displayName ?? 'Organization member'; }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
const openSecretary = (event: Event): void => { const detail = (event as CustomEvent<{ tabId?: string }>).detail; if (!detail?.tabId || detail.tabId === props.tabId) { secretaryOpen.value = true; startSecretary(); } };
const notesSaved = (event: Event): void => { const detail = (event as CustomEvent<{ conversationId?: string; path?: string }>).detail; if (detail?.conversationId && detail.path) savedNotes.value = { ...savedNotes.value, [detail.conversationId]: detail.path }; };
watch(activeOrg, () => { if (activeOrg.value && !loading.value) void refresh(); });
onMounted(() => { void initialize(); window.addEventListener('sulla:open-conversations-secretary', openSecretary); window.addEventListener('sulla:secretary-notes-saved', notesSaved); });
onBeforeUnmount(() => { window.removeEventListener('sulla:open-conversations-secretary', openSecretary); window.removeEventListener('sulla:secretary-notes-saved', notesSaved); });
</script>

<style scoped>
.cv-root{height:100%;min-height:0;display:grid;grid-template-columns:224px 300px minmax(380px,1fr) 270px;color:var(--text-primary);background:var(--bg-page);font:13px/1.45 var(--font-body);position:relative;overflow:hidden}
.cv-nav{display:flex;flex-direction:column;gap:7px;padding:18px 14px;border-right:1px solid var(--border-default);background:color-mix(in srgb,var(--bg-surface) 94%,transparent);min-height:0}
.cv-brand{display:flex;align-items:center;gap:10px;padding:2px 7px 12px}.cv-brand img{width:30px;height:30px;object-fit:contain}.cv-brand b,.cv-brand small{display:block}.cv-brand b{font-size:13px}.cv-brand small{font-size:11px;color:var(--text-muted)}
.cv-org-label{display:grid;gap:5px;margin:0 7px 8px;font-size:10px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--text-muted)}.cv-org-label select{padding:7px 8px;border:1px solid var(--border-default);border-radius:7px;background:var(--bg-surface);color:var(--text-primary);font-size:12px;text-transform:none;letter-spacing:0}
.cv-nav-item{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;text-align:left;color:var(--text-muted);font-weight:500}.cv-nav-item:hover,.cv-nav-item.active{background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent)}.cv-nav-item svg,.cv-search svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}.cv-count{margin-left:auto;font-size:11px}.cv-nav-divider{height:1px;background:var(--border-default);margin:8px 7px}.cv-note{padding:3px 8px;color:var(--text-muted);font-size:11px;line-height:1.5}.cv-nav-bottom{margin-top:auto;padding:11px 8px 0;border-top:1px solid var(--border-default);display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:11px}.cv-presence-dot{width:7px;height:7px;border-radius:50%;background:var(--status-success)}
.cv-list{min-width:0;min-height:0;display:flex;flex-direction:column;border-right:1px solid var(--border-default);background:color-mix(in srgb,var(--bg-surface) 76%,transparent)}.cv-list-head{padding:15px 14px 10px;border-bottom:1px solid var(--border-default)}.cv-list-title{display:flex;align-items:center;justify-content:space-between}.cv-list-title h1{margin:0 0 10px;font-size:15px;font-weight:650}.cv-search{display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg-surface);color:var(--text-muted)}.cv-search input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--text-primary)}.cv-segments{display:flex;margin-top:10px;padding:2px;gap:2px;border:1px solid var(--border-default);border-radius:7px;background:var(--bg-surface)}.cv-segments button{flex:1;border:0;border-radius:5px;padding:5px;background:transparent;color:var(--text-muted);font-size:11px}.cv-segments button.active{background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent);font-weight:650}.cv-list-body{min-height:0;overflow:auto;padding:6px}.cv-overline{padding:10px 9px 4px;color:var(--text-dim);font-size:10px;font-weight:650;letter-spacing:.07em;text-transform:uppercase}.cv-row{display:flex;align-items:center;gap:10px;width:100%;padding:9px;border:0;border-radius:9px;background:transparent;text-align:left;color:inherit;cursor:pointer}.cv-row:hover{background:color-mix(in srgb,var(--text-primary) 5%,transparent)}.cv-row.selected{background:color-mix(in srgb,var(--accent) 12%,transparent)}.cv-select-person{accent-color:var(--accent);margin:0 0 0 1px}.cv-group-create{display:flex;align-items:center;justify-content:space-between;padding:5px 8px 8px;color:var(--text-muted);font-size:10.5px}.cv-avatar{position:relative;flex:none;width:34px;height:34px;display:grid;place-items:center;border-radius:50%;background:linear-gradient(135deg,#9ec1d3,var(--accent));color:white;font-size:11px;font-weight:700}.cv-avatar.agent{border-radius:9px;background:linear-gradient(135deg,#8b78d1,#443074)}.cv-avatar i{position:absolute;right:-1px;bottom:-1px;width:9px;height:9px;border:2px solid var(--bg-surface);border-radius:50%;background:var(--status-success)}.cv-avatar.offline i{background:var(--text-dim)}.cv-avatar.small{width:24px;height:24px;font-size:9px}.cv-row-copy{min-width:0;flex:1}.cv-row-copy b,.cv-row-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cv-row-copy b{font-size:12px;font-weight:600}.cv-row-copy small{margin-top:2px;color:var(--text-muted);font-size:10.5px}.cv-row-copy .cv-agent-label{font-size:10px}.cv-row-action{display:none;color:var(--accent);font-size:11px}.cv-row:hover .cv-row-action{display:block}.cv-thread-preview{max-width:225px}.cv-unread{display:grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:99px;background:var(--accent);color:white;font-size:10px;font-weight:700}
.cv-main{display:flex;flex-direction:column;min-width:0;min-height:0;position:relative}.cv-thread-head{display:flex;align-items:center;gap:10px;min-height:58px;padding:10px 18px;border-bottom:1px solid var(--border-default);background:color-mix(in srgb,var(--bg-surface) 70%,transparent)}.cv-thread-head>span:nth-child(2){min-width:0}.cv-thread-head b,.cv-thread-head small{display:block}.cv-thread-head b{font-size:13px}.cv-thread-head small{font-size:10.5px;color:var(--text-muted)}.cv-thread-actions{display:flex;gap:5px;margin-left:auto}.cv-messages{flex:1;min-height:0;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:16px}.cv-message{display:flex;gap:9px;max-width:800px}.cv-message.mine{align-self:flex-end;flex-direction:row-reverse}.cv-message-body{min-width:0}.cv-message-meta{display:flex;gap:8px;align-items:baseline;font-size:11px}.cv-message-meta time{color:var(--text-dim);font-size:10px}.cv-message-body p{margin:3px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55}.cv-ref-card{margin-top:6px;padding:8px 10px;border:1px solid var(--border-default);border-radius:8px;background:var(--bg-surface);font-size:11px;color:var(--text-muted)}.cv-composer{padding:10px 18px 14px}.cv-composer textarea{width:100%;min-height:67px;resize:vertical;padding:10px;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg-surface);color:var(--text-primary);font:12px/1.5 var(--font-body);outline-color:var(--accent)}.cv-composer-foot{display:flex;align-items:center;gap:7px;padding-top:7px}.cv-composer-hint{margin-right:auto;color:var(--text-dim);font-size:10px}.cv-error{margin-right:auto;color:var(--status-error);font-size:11px}
.cv-details{min-width:0;min-height:0;overflow:auto;padding:16px 13px;border-left:1px solid var(--border-default);background:color-mix(in srgb,var(--bg-surface) 86%,transparent)}.cv-details h2{margin:0 0 11px;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-dim)}.cv-detail-card{margin-bottom:10px;padding:11px;border:1px solid var(--border-default);border-radius:10px;background:var(--bg-surface)}.cv-detail-card b,.cv-detail-card small{display:block}.cv-detail-card small,.cv-detail-card p{margin:4px 0 0;color:var(--text-muted);font-size:10.5px;line-height:1.5}.cv-detail-card hr{border:0;border-top:1px solid var(--border-default);margin:9px 0}.cv-detail-card h3{margin:0;font-size:11px}.cv-detail-title{display:flex;align-items:center;gap:7px}.cv-detail-title svg{width:15px;height:15px;stroke:var(--accent);fill:none;stroke-width:1.7}.cv-empty{padding:22px 10px;text-align:center;color:var(--text-muted);font-size:12px}.cv-empty-state{margin:auto;max-width:300px;padding:22px;text-align:center;color:var(--text-muted)}.cv-empty-state b{display:block;color:var(--text-primary);font-size:14px}.cv-empty-state p{font-size:11.5px;line-height:1.55}.cv-empty-icon{width:38px;height:38px;margin:0 auto 12px;display:grid;place-items:center;border-radius:12px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent)}.cv-empty-icon svg{width:19px;height:19px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round}.cv-message-empty{margin:auto}.cv-main-empty{margin:auto}.cv-primary,.cv-secondary,.cv-icon-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 10px;border:1px solid var(--border-strong);border-radius:7px;background:var(--bg-surface);color:var(--text-primary);font:500 11px var(--font-body);cursor:pointer}.cv-primary{border-color:var(--accent);background:var(--accent);color:white}.cv-primary:disabled,.cv-secondary:disabled{opacity:.5;cursor:not-allowed}.cv-icon-button{width:27px;height:27px;padding:0;font-size:17px}.cv-modal{position:absolute;inset:12px;z-index:5;display:flex;flex-direction:column;border:1px solid var(--border-default);border-radius:12px;background:var(--bg-page);box-shadow:0 18px 60px color-mix(in srgb,var(--text-primary) 20%,transparent);overflow:hidden}.cv-modal>header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border-default)}.cv-secretary-body{flex:1;min-height:0;overflow:hidden}.cv-load-indicator{position:absolute;right:16px;bottom:12px;padding:6px 9px;border-radius:6px;background:var(--bg-surface);color:var(--text-muted);font-size:10px;box-shadow:0 2px 8px #0002}
@media(max-width:1400px){.cv-root{grid-template-columns:200px 270px minmax(380px,1fr)}.cv-details{display:none}}
@media(max-width:900px){.cv-root{grid-template-columns:180px minmax(220px,34%) minmax(320px,1fr)}.cv-nav{padding:12px 8px}}
</style>
