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
import { ConversationViewBuilder } from './ConversationViewBuilder';
import { ConversationDataState, OrgConversationsLoader, type OrgConversationsGateway } from './OrgConversationsData';
import ConvList from './components/ConvList.vue';
import ConvNav from './components/ConvNav.vue';
import ConvSide from './components/ConvSide.vue';
import ConvThread from './components/ConvThread.vue';

type Org = { orgId: string; name: string; slug?: string; memberCount: number };
type MessageData = ConversationMessageData;

const props = defineProps<{ tabId: string }>();
defineEmits<{ (event: 'set-mode', mode: string): void }>();

// Data layer: org list, directory, inbox, participant, start and send, all through the existing IPC.
const organizations = ref<Org[]>([]), activeOrg = ref(''), sending = ref(false), secretaryOpen = ref(false), error = ref(''), loading = ref(false);
// Org data (people, inbox, requests, member id, sent-but-not-yet-returned messages) lives in one state object that
// only the newest load may write. A failed read keeps the last good data for the same org.
const dataState = new ConversationDataState();
const data = dataState.data;
const loader = new OrgConversationsLoader(gateway());
const people = computed(() => data.people);
const emptyConversations = ref<ConversationThreadProjection[]>([]);
const projection = new ConversationProjection();
// The nav status card: the Settings → Sulla Cloud connection status and the browser's network state.
const cloudStatus = ref<Record<string, any> | null>(null);
const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
let mounted = false, initializing = false, retryAttempt = 0, retryTimer: number | undefined;
const retryDelays = [2_000, 5_000, 10_000, 20_000, 30_000];

const store = new ConversationScreenStore();
provide(CONV_STORE, store);

function gateway(): OrgConversationsGateway {
  return {
    directory: org => ipcRenderer.invoke('org-conversations:directory', org),
    inbox: org => ipcRenderer.invoke('org-conversations:inbox', org),
    participant: org => ipcRenderer.invoke('org-conversations:participant', org),
    contactRequests: org => ipcRenderer.invoke('org-conversations:contact-requests', org),
    memberships: org => ipcRenderer.invoke('org-conversations:memberships', org),
    invitations: org => ipcRenderer.invoke('org-conversations:invitations', org),
  };
}

const threads = computed<ConversationThreadProjection[]>(() => {
  // A sent message can briefly sit in both the inbox and the local list; keep one copy per id.
  const unique = new Map<string, MessageData>();
  for (const message of [...data.messages, ...data.localSent]) unique.set(message.messageId, message);
  const loaded = projection.project([...unique.values()], people.value, activeOrg.value, data.userId);
  const ids = new Set(loaded.map(thread => thread.id));
  return [...loaded, ...emptyConversations.value.filter(thread => !ids.has(thread.id))].sort((a, b) => (b.messages.at(-1)?.createdAt ?? '').localeCompare(a.messages.at(-1)?.createdAt ?? ''));
});

/** Maps the real inbox and directory into the view models the components render. */
const snapshot = computed<LiveSnapshot | null>(() => {
  if (!activeOrg.value) return null;
  const views = new ConversationViewBuilder(people.value, data.userId);
  const orgs: OrgView[] = organizations.value.map(org => ({ id: org.orgId, name: org.name, initials: initials(org.name), memberCount: org.memberCount, gradient: views.orgGradient(org.orgId) }));
  const self = people.value.find(person => person.userId === data.userId);
  const memberViews: PersonView[] = people.value.filter(person => person.userId !== data.userId).map(person => views.person(person));
  const threadViews: ThreadView[] = threads.value.map(thread => views.thread(thread));
  const bodies: Record<string, MessageView[]> = {};
  for (const thread of threads.value) bodies[thread.id] = thread.messages.map(message => views.message(message));
  const requests: RequestView[] = [];
  for (const request of data.requests) {
    const existing = requests.find(view => view.senderId === request.from.userId);
    if (existing) { existing.count += 1; continue; }
    requests.push({ senderId: request.from.userId, name: displayName(request.from.userId), initials: initials(displayName(request.from.userId)), latest: request.body.text, time: formatTime(request.createdAt), count: 1 });
  }
  const activeName = organizations.value.find(org => org.orgId === activeOrg.value)?.name ?? '';
  return { orgId: activeOrg.value, orgName: activeName, orgs, me: self ? views.person(self) : null, people: memberViews, invited: data.invited.map(entry => views.invitation(entry)), threads: threadViews, requests, bodies, relay: views.relayState(cloudStatus.value, online.value), online: online.value };
});

function displayName(id: string): string {
  return people.value.find(person => person.userId === id)?.displayName ?? 'Organization member';
}

/**
 * Loads the active org. Every read is independent: a failed read keeps the last good data for this org and
 * names the failure in the status line. A load that a newer org switch or refresh has overtaken writes nothing.
 */
async function refresh(): Promise<void> {
  const requestedOrg = activeOrg.value;
  if (!requestedOrg) return;
  const token = dataState.begin(requestedOrg);
  loading.value = true;
  const load = await loader.load(requestedOrg);
  if (!dataState.apply(token, requestedOrg, load)) return;
  error.value = load.problems.join(' ');
  loading.value = false;
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
    dataState.addSent(result.message as MessageData);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Message was not sent'; }
  finally { sending.value = false; }
}

async function createGroup(personIds: string[]): Promise<void> {
  const unique = [...new Set(personIds)];
  if (unique.length < 2) return;
  error.value = '';
  try {
    const humanId = data.userId || (await ipcRenderer.invoke('org-conversations:participant', activeOrg.value)).userId;
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
    const humanId = data.userId || (await ipcRenderer.invoke('org-conversations:participant', activeOrg.value)).userId;
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

watch(snapshot, value => store.setLive(value), { immediate: true });

store.sendHandler = text => void sendMessage(text);
store.orgSwitchHandler = orgId => {
  if (orgId === activeOrg.value) return;
  activeOrg.value = orgId;
  emptyConversations.value = [];
  void refresh();
};
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
