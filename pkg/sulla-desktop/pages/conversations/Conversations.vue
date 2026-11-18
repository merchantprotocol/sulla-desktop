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
import { ConversationViewBuilder, type DirectoryPerson } from './ConversationViewBuilder';
import ConvList from './components/ConvList.vue';
import ConvNav from './components/ConvNav.vue';
import ConvSide from './components/ConvSide.vue';
import ConvThread from './components/ConvThread.vue';

type Org = { orgId: string; name: string; slug?: string; memberCount: number };
type Person = DirectoryPerson;
type MessageData = ConversationMessageData;

const props = defineProps<{ tabId: string }>();
defineEmits<{ (event: 'set-mode', mode: string): void }>();

// Data layer: org list, directory, inbox, participant, start and send, all through the existing IPC.
const organizations = ref<Org[]>([]), activeOrg = ref(''), people = ref<Person[]>([]), messages = ref<MessageData[]>([]), localSent = ref<MessageData[]>([]);
const contactRequests = ref<MessageData[]>([]);
const userId = ref(''), userName = ref(''), loading = ref(false), sending = ref(false), secretaryOpen = ref(false), error = ref('');
const emptyConversations = ref<ConversationThreadProjection[]>([]);
const projection = new ConversationProjection();
// The nav status card: the Settings → Sulla Cloud connection status and the browser's network state.
const cloudStatus = ref<Record<string, any> | null>(null);
const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
let mounted = false, initializing = false, retryAttempt = 0, retryTimer: number | undefined;
const retryDelays = [2_000, 5_000, 10_000, 20_000, 30_000];

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
  const views = new ConversationViewBuilder(people.value, userId.value);
  const orgs: OrgView[] = organizations.value.map(org => ({ id: org.orgId, name: org.name, initials: initials(org.name), memberCount: org.memberCount, gradient: views.orgGradient(org.orgId) }));
  const self = people.value.find(person => person.userId === userId.value);
  const memberViews: PersonView[] = people.value.filter(person => person.userId !== userId.value).map(person => views.person(person));
  const threadViews: ThreadView[] = threads.value.map(thread => views.thread(thread));
  const bodies: Record<string, MessageView[]> = {};
  for (const thread of threads.value) bodies[thread.id] = thread.messages.map(message => views.message(message));
  const requests: RequestView[] = [];
  for (const request of contactRequests.value) {
    const existing = requests.find(view => view.senderId === request.from.userId);
    if (existing) { existing.count += 1; continue; }
    requests.push({ senderId: request.from.userId, name: displayName(request.from.userId), initials: initials(displayName(request.from.userId)), latest: request.body.text, time: formatTime(request.createdAt), count: 1 });
  }
  const activeName = organizations.value.find(org => org.orgId === activeOrg.value)?.name ?? '';
  return { orgId: activeOrg.value, orgName: activeName, orgs, me: self ? views.person(self) : null, people: memberViews, threads: threadViews, requests, bodies, relay: views.relayState(cloudStatus.value, online.value), online: online.value };
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
  if (!mounted || initializing) return;
  initializing = true;
  loading.value = true;
  try {
    organizations.value = [...await ipcRenderer.invoke('org-conversations:organizations')];
    if (!organizations.value.length) {
      // An empty success is a real answer: stop loading so ConvNav shows "No organization", and keep watching for one.
      error.value = '';
      loading.value = false;
      scheduleOrganizationRetry();
      return;
    }
    retryAttempt = 0;
    clearOrganizationRetry();
    if (!activeOrg.value) activeOrg.value = organizations.value[0].orgId;
    loading.value = false;
    await refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not load your organizations';
    loading.value = true;
    scheduleOrganizationRetry();
  } finally {
    initializing = false;
    if (retryTimer === undefined && organizations.value.length) loading.value = false;
  }
}

function scheduleOrganizationRetry(): void {
  if (!mounted || retryTimer !== undefined) return;
  const delay = retryDelays[Math.min(retryAttempt, retryDelays.length - 1)];
  retryAttempt++;
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined;
    void initialize();
  }, delay);
}

function clearOrganizationRetry(): void {
  if (retryTimer === undefined) return;
  window.clearTimeout(retryTimer);
  retryTimer = undefined;
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
// Opening Secretary never starts the microphone; only an explicit start (the
// secretary/start tool or the Start button inside SecretaryMode) begins listening.
function openSecretaryModal(start = false): void { secretaryOpen.value = true; if (start) startSecretary(); }
function initials(label: string): string { return label.split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase() || '?'; }
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
const openSecretary = (event: Event): void => {
  const detail = (event as CustomEvent<{ tabId?: string; start?: boolean }>).detail;
  if (!detail?.tabId || detail.tabId === props.tabId) openSecretaryModal(detail?.start === true);
};

watch(activeOrg, () => { if (activeOrg.value && !loading.value) void refresh(); });
watch(snapshot, value => store.setLive(value), { immediate: true });

store.sendHandler = text => void sendMessage(text);
store.orgSwitchHandler = orgId => { activeOrg.value = orgId; };
store.directHandler = personId => void openDirect(personId);
store.groupHandler = personIds => void createGroup(personIds);
store.secretaryHandler = () => openSecretaryModal();

const onCloudStatus = (_event: unknown, status: Record<string, any>): void => {
  cloudStatus.value = status;
  if (status?.signedIn === true && organizations.value.length === 0) {
    clearOrganizationRetry();
    void initialize();
  }
};
const goOnline = (): void => { online.value = true; };
const goOffline = (): void => { online.value = false; };

onMounted(() => {
  mounted = true;
  void initialize();
  window.addEventListener('sulla:open-conversations-secretary', openSecretary);
  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);
  ipcRenderer.on('sulla-cloud-connection:status-changed', onCloudStatus);
  ipcRenderer.invoke('sulla-cloud-connection:get-status').then(status => { cloudStatus.value = status; }).catch(() => undefined);
});
onBeforeUnmount(() => {
  mounted = false;
  clearOrganizationRetry();
  window.removeEventListener('sulla:open-conversations-secretary', openSecretary);
  window.removeEventListener('online', goOnline);
  window.removeEventListener('offline', goOffline);
  ipcRenderer.removeListener('sulla-cloud-connection:status-changed', onCloudStatus);
  store.dispose();
});
</script>

<template>
  <div class="cv-root">
    <div class="app">
      <ConvNav :loading="loading" />
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
