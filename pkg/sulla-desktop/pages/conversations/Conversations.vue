<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import SecretaryMode from '@pkg/pages/SecretaryMode.vue';
import { ConversationProjection, type ConversationMessageData, type ConversationThreadProjection } from './ConversationProjection';
import { CONV_STORE, ConversationScreenStore, type LiveSnapshot, type MessageView, type OrgView, type PersonView, type RequestView, type ThreadView } from './ConversationScreenStore';
import ConvList from './components/ConvList.vue';
import ConvNav from './components/ConvNav.vue';
import ConvSide from './components/ConvSide.vue';
import ConvThread from './components/ConvThread.vue';

type Org = { orgId: string; name: string; slug?: string; memberCount: number };
type Person = { userId: string; displayName: string; presence?: string; agentHostOnline?: boolean; agentName?: string };
type MessageData = ConversationMessageData;

const props = defineProps<{ tabId: string }>();
defineEmits<{ (event: 'set-mode', mode: string): void }>();

// Data layer: org list, directory, inbox, participant, start and send, all through the existing IPC.
const organizations = ref<Org[]>([]), activeOrg = ref(''), people = ref<Person[]>([]), messages = ref<MessageData[]>([]), localSent = ref<MessageData[]>([]);
const contactRequests = ref<MessageData[]>([]);
const userId = ref(''), userName = ref(''), loading = ref(false), sending = ref(false), secretaryOpen = ref(false), error = ref('');
const emptyConversations = ref<ConversationThreadProjection[]>([]);
const projection = new ConversationProjection();

const store = new ConversationScreenStore();
provide(CONV_STORE, store);

const threads = computed<ConversationThreadProjection[]>(() => {
  const loaded = projection.project([...messages.value, ...localSent.value], people.value, activeOrg.value, userId.value);
  const ids = new Set(loaded.map(thread => thread.id));
  return [...loaded, ...emptyConversations.value.filter(thread => !ids.has(thread.id))].sort((a, b) => (b.messages.at(-1)?.createdAt ?? '').localeCompare(a.messages.at(-1)?.createdAt ?? ''));
});

/** Maps the real inbox and directory into the view models the components render. */
const snapshot = computed<LiveSnapshot | null>(() => {
  if (!activeOrg.value) return null;
  const orgs: OrgView[] = organizations.value.map(org => ({ id: org.orgId, name: org.name, initials: initials(org.name), memberCount: org.memberCount }));
  const memberViews: PersonView[] = people.value.filter(person => person.userId !== userId.value).map(person => ({
    id: person.userId,
    name: person.displayName,
    initials: initials(person.displayName),
    presence: person.presence ?? '',
    agentOnline: !!person.agentHostOnline,
  }));
  const threadViews: ThreadView[] = threads.value.map(thread => ({
    id: thread.id,
    kind: thread.kind,
    title: thread.title,
    participantIds: thread.participantIds,
    latest: thread.latest,
    time: formatTime(thread.messages.at(-1)?.createdAt ?? ''),
  }));
  const bodies: Record<string, MessageView[]> = {};
  for (const thread of threads.value) {
    bodies[thread.id] = thread.messages.map((message): MessageView => {
      const mine = message.from.userId === userId.value && !message.from.agentId;
      const agent = !!message.from.agentId;
      const name = mine ? 'You' : agent ? `${displayName(message.from.userId)}’s agent` : displayName(message.from.userId);
      return { id: message.messageId, side: mine ? 'me' : agent ? 'agent' : 'person', name, initials: mine ? initials(userName.value) : initials(displayName(message.from.userId)), time: formatTime(message.createdAt), text: message.body.text };
    });
  }
  const requests: RequestView[] = [];
  for (const request of contactRequests.value) {
    const existing = requests.find(view => view.senderId === request.from.userId);
    if (existing) { existing.count += 1; continue; }
    requests.push({ senderId: request.from.userId, name: displayName(request.from.userId), initials: initials(displayName(request.from.userId)), latest: request.body.text, time: formatTime(request.createdAt), count: 1 });
  }
  const activeName = organizations.value.find(org => org.orgId === activeOrg.value)?.name ?? '';
  return { orgId: activeOrg.value, orgName: activeName, orgs, people: memberViews, threads: threadViews, requests, bodies };
});

function displayName(id: string): string {
  return people.value.find(person => person.userId === id)?.displayName ?? 'Organization member';
}

async function refresh(): Promise<void> {
  if (!activeOrg.value) return;
  const requestedOrg = activeOrg.value;
  loading.value = true; error.value = ''; people.value = []; messages.value = []; contactRequests.value = []; emptyConversations.value = []; localSent.value = [];
  try {
    const [directory, inbox, participant, contact] = await Promise.all([
      ipcRenderer.invoke('org-conversations:directory', activeOrg.value),
      ipcRenderer.invoke('org-conversations:inbox', activeOrg.value),
      ipcRenderer.invoke('org-conversations:participant', activeOrg.value),
      ipcRenderer.invoke('org-conversations:contact-requests', activeOrg.value),
    ]);
    if (activeOrg.value !== requestedOrg) return;
    people.value = (directory.directory.people as Person[]).map((person: any) => ({ ...person, userId: person.userId ?? person.id, displayName: person.displayName ?? person.name ?? person.userId ?? person.id }));
    messages.value = inbox.messages as MessageData[];
    contactRequests.value = contact.requests as MessageData[];
    userId.value = participant.userId;
    userName.value = people.value.find(person => person.userId === participant.userId)?.displayName ?? '';
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

async function sendMessage(text: string): Promise<void> {
  const conversationId = store.s.thread;
  const target = threads.value.find(thread => thread.id === conversationId);
  if (!target || !text.trim() || sending.value) return;
  sending.value = true; error.value = '';
  try {
    const result = await ipcRenderer.invoke('org-conversations:send', { orgId: activeOrg.value, conversationId, toUserIds: target.participantIds, text: text.trim() });
    localSent.value = [...localSent.value, result.message as MessageData];
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Message was not sent'; }
  finally { sending.value = false; }
}

async function createGroup(personIds: string[]): Promise<void> {
  const unique = [...new Set(personIds)];
  if (unique.length < 2) return;
  error.value = '';
  try {
    const humanId = userId.value || (await ipcRenderer.invoke('org-conversations:participant', activeOrg.value)).userId;
    const participantIds = [humanId, ...unique];
    const result = await ipcRenderer.invoke('org-conversations:start', { orgId: activeOrg.value, participantUserIds: participantIds, kind: 'group' });
    const org = activeOrg.value;
    store.setListTab('threads');
    await refresh();
    if (activeOrg.value !== org) return;
    const title = unique.map(id => displayName(id)).join(', ');
    emptyConversations.value = [...emptyConversations.value.filter(thread => thread.id !== result.conversationId), { id: result.conversationId, kind: 'group', title, participantIds, messages: [], latest: '', unread: 0 }];
    store.openThread(result.conversationId);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not start group conversation'; }
}

async function openDirect(personId: string): Promise<void> {
  error.value = '';
  try {
    const humanId = userId.value || (await ipcRenderer.invoke('org-conversations:participant', activeOrg.value)).userId;
    const participantIds = [humanId, personId];
    const result = await ipcRenderer.invoke('org-conversations:start', { orgId: activeOrg.value, participantUserIds: participantIds, kind: 'direct' });
    const org = activeOrg.value;
    store.setListTab('threads');
    await refresh();
    if (activeOrg.value !== org) return;
    emptyConversations.value = [...emptyConversations.value.filter(thread => thread.id !== result.conversationId), { id: result.conversationId, kind: 'direct', title: displayName(personId), participantIds, messages: [], latest: '', unread: 0 }];
    store.openThread(result.conversationId);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not start conversation'; }
}

function startSecretary(): void {
  void nextTick(() => window.setTimeout(() => window.dispatchEvent(new CustomEvent('sulla:secretary-start', { detail: { tabId: props.tabId } })), 40));
}
function openSecretaryModal(): void { secretaryOpen.value = true; startSecretary(); }
function initials(label: string): string { return label.split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase() || '?'; }
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
const openSecretary = (event: Event): void => {
  const detail = (event as CustomEvent<{ tabId?: string }>).detail;
  if (!detail?.tabId || detail.tabId === props.tabId) openSecretaryModal();
};

watch(activeOrg, () => { if (activeOrg.value && !loading.value) void refresh(); });
watch(snapshot, value => store.setLive(value), { immediate: true });

store.sendHandler = text => void sendMessage(text);
store.orgSwitchHandler = orgId => { activeOrg.value = orgId; };
store.directHandler = personId => void openDirect(personId);
store.groupHandler = personIds => void createGroup(personIds);
store.secretaryHandler = () => openSecretaryModal();

onMounted(() => {
  void initialize();
  window.addEventListener('sulla:open-conversations-secretary', openSecretary);
});
onBeforeUnmount(() => {
  window.removeEventListener('sulla:open-conversations-secretary', openSecretary);
  store.dispose();
});
</script>

<template>
  <div class="cv-root">
    <div class="app">
      <ConvNav />
      <ConvList />
      <ConvThread :error="error" />
      <ConvSide />
    </div>
    <div v-show="secretaryOpen" class="cv-modal" role="dialog" aria-modal="true" aria-label="Secretary Mode">
      <header><b>Secretary Mode</b><button class="cv-icon-button" aria-label="Close Secretary Mode" @click="secretaryOpen = false">×</button></header>
      <div class="cv-secretary-body"><SecretaryMode :tab-id="tabId" :conversation-id="store.s.thread ?? undefined" @set-mode="$emit('set-mode', $event)" /></div>
    </div>
    <div v-if="loading" class="cv-load-indicator">Loading organization conversations…</div>
  </div>
</template>

<style src="./conversations.css"></style>
