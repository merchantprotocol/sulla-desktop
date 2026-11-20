<!-- Sulla Desktop · https://sulladesktop.com · SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { ConversationServersData, type ConversationChannel, type ConversationServer, type ConversationServerMember, type NotificationLevel } from '../ConversationServersData';
import { DirectoryPersonNormalizer } from '../DirectoryPersonNormalizer';
import { ConversationServersLiveUpdateHandler } from '../ConversationServersLiveUpdateHandler';
import { ConversationChannelComposer, type ConversationChannelTarget } from '../ConversationChannelComposer';

const props = defineProps<{ orgId: string; currentUserId: string; people: { userId: string; displayName: string }[] }>();
defineEmits<{ (event: 'exit'): void }>();
const domain = new ConversationServersData();
const composer = new ConversationChannelComposer();
const composerRevision = ref(0);
const servers = ref<ConversationServer[]>([]), channels = ref<ConversationChannel[]>([]), members = ref<ConversationServerMember[]>([]);
const memberNames = ref<{ userId: string; displayName: string }[]>([]);
const messages = ref<{ id: string; seq: number; authorUserId: string; body: string }[]>([]);
const unreadByChannel = ref<Record<string, { unreadCount?: number; mentionCount?: number; unread?: number; mentions?: number }>>({});
const loadingOlder = ref(false), sending = ref(false);
const orgMembers = ref<{ userId: string; role?: string; displayName?: string }[]>([]);
const organizations = ref<{ orgId: string; name: string }[]>([]);
const createOpen = ref(false), createName = ref(''), createVisibility = ref<'public' | 'organization'>('public'), createOrgId = ref(''), creating = ref(false);
const discoverOpen = ref(false), discoverQuery = ref('');
const selectedServer = ref(''), selectedChannel = ref(''), error = ref(''), loading = ref(false), openMenu = ref('');
const server = computed(() => servers.value.find(item => item.id === selectedServer.value));
const publicServers = computed(() => servers.value.filter(item => item.visibility === 'public'));
const discoveredServers = computed(() => {
  const query = discoverQuery.value.trim().toLocaleLowerCase();
  return publicServers.value.filter(item => !query || item.name.toLocaleLowerCase().includes(query));
});
const organizationServers = computed(() => servers.value.filter(item => item.visibility === 'organization'));
const channel = computed(() => channels.value.find(item => item.id === selectedChannel.value));
const canManageServer = computed(() => !!props.currentUserId && (server.value?.ownerUserId === props.currentUserId || members.value.some(member => member.userId === props.currentUserId && ['owner', 'admin'].includes(member.role))));
const visibleMembers = computed(() => channel.value?.private
  ? (channel.value.memberUserIds ?? []).map(userId => ({ userId, role: '' }))
  : server.value?.visibility === 'organization' ? orgMembers.value : members.value);
const levels: { id: NotificationLevel; label: string }[] = [{ id: 'all', label: 'All messages' }, { id: 'mentions', label: 'Only @mentions' }, { id: 'nothing', label: 'Nothing' }];
let latestLoad = 0;
async function load(): Promise<void> {
  const loadId = ++latestLoad;
  loading.value = true; error.value = '';
  try {
    // Public and organization server lists are returned by the authenticated Cloud API; no sample data is used.
    const orgs = await ipcRenderer.invoke('org-conversations:organizations') as { orgId: string; name: string }[];
    organizations.value = orgs;
    const orgIds = orgs.map(org => org.orgId);
    const [publicServers, ...orgServers] = await Promise.all([
      ipcRenderer.invoke('conversation-servers:list') as Promise<ConversationServer[]>,
      ...orgIds.map(orgId => ipcRenderer.invoke('conversation-servers:list', orgId) as Promise<ConversationServer[]>),
    ]);
    const all = [...publicServers, ...orgServers.flat()];
    if (loadId !== latestLoad) return;
    servers.value = all.filter((item, index) => all.findIndex(other => other.id === item.id) === index);
    if (!servers.value.some(item => item.id === selectedServer.value)) selectedServer.value = '';
    if (!selectedServer.value) { channels.value = []; members.value = []; selectedChannel.value = ''; return; }
    const [nextChannels, nextMembers] = await Promise.all([
      ipcRenderer.invoke('conversation-servers:channels', selectedServer.value) as Promise<ConversationChannel[]>,
      ipcRenderer.invoke('conversation-servers:members', selectedServer.value) as Promise<ConversationServerMember[]>,
    ]);
    let names: { userId: string; displayName: string }[] = [];
    let teamMembers: { userId: string; role?: string; displayName?: string }[] = [];
    if (server.value?.orgId && server.value.orgId === props.orgId) names = props.people;
    else if (server.value?.orgId) {
      try {
        const [directory, membershipResult] = await Promise.all([
          ipcRenderer.invoke('org-conversations:directory', server.value.orgId) as Promise<{ directory?: { people?: unknown[] } }>,
          ipcRenderer.invoke('org-conversations:memberships', server.value.orgId) as Promise<{ memberships?: { userId?: unknown; role?: unknown }[] }>,
        ]);
        const normalizer = new DirectoryPersonNormalizer();
        const rawPeople = (directory.directory?.people ?? []).filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object');
        const people = normalizer.withRoles(rawPeople, membershipResult.memberships ?? []);
        names = people.map(person => ({ userId: person.userId, displayName: person.displayName }));
        teamMembers = people.map(person => ({ userId: person.userId, displayName: person.displayName, role: person.role }));
      } catch { names = []; }
    }
    if (server.value?.orgId && server.value.orgId === props.orgId) teamMembers = props.people.map(person => ({ userId: person.userId, displayName: person.displayName, role: 'role' in person && typeof person.role === 'string' ? person.role : undefined }));
    if (loadId !== latestLoad) return;
    memberNames.value = names;
    orgMembers.value = teamMembers;
    const withPreferences = await Promise.all(nextChannels.map(async (item: ConversationChannel) => {
      try {
        const pref = await ipcRenderer.invoke('conversation-servers:channel-preference', { serverId: selectedServer.value, channelId: item.id }) as { level: NotificationLevel; preference: NotificationLevel | null; channelOverride: NotificationLevel | null };
        return { ...item, notificationLevel: domain.effectiveLevel(server.value!, { ...item, notificationOverride: pref.channelOverride ?? undefined }, pref.preference ?? undefined), notificationOverride: pref.channelOverride ?? undefined, notificationPreference: pref.preference ?? undefined, notificationAvailable: true };
      } catch (cause) {
        // Public channels can be browsed before joining; the API correctly hides member preferences from nonmembers.
        if (cause instanceof Error && cause.message.includes('(404)') && server.value?.visibility === 'public') return { ...item, notificationLevel: serverDefault(), notificationAvailable: false };
        throw cause;
      }
    }));
    if (loadId !== latestLoad) return;
    channels.value = withPreferences; members.value = nextMembers;
    if (!channels.value.some(item => item.id === selectedChannel.value)) selectedChannel.value = channels.value[0]?.id ?? '';
  } catch (cause) {
    if (loadId === latestLoad) {
      const publicServer = servers.value.find(item => item.id === selectedServer.value && item.visibility === 'public');
      const message = cause instanceof Error ? cause.message : '';
      error.value = publicServer && /\((403|404)\)/.test(message)
        ? 'Membership is required to open this public server.'
        : message || 'Could not load servers';
    }
  }
  finally { if (loadId === latestLoad) loading.value = false; }
}
async function loadMessages(before?: number, target: ConversationChannelTarget = currentTarget()): Promise<void> {
  if (!target.serverId || !target.channelId) return;
  const response = await ipcRenderer.invoke('conversation-servers:messages', { serverId: target.serverId, channelId: target.channelId, before }) as { messages?: { id: string; seq: number; authorUserId: string; body: string }[] };
  const page = response.messages ?? [];
  const stillSelected = selectedServer.value === target.serverId && selectedChannel.value === target.channelId;
  const nextMessages = before === undefined ? page : [...page, ...messages.value.filter(old => !page.some(item => item.id === old.id))];
  if (stillSelected) messages.value = nextMessages;
  const last = nextMessages[nextMessages.length - 1];
  if (last) await ipcRenderer.invoke('conversation-servers:read', { serverId: target.serverId, channelId: target.channelId, seq: last.seq });
  await loadUnread(target.serverId);
}
async function loadUnread(serverId = selectedServer.value): Promise<void> {
  if (!serverId) return;
  const result = await ipcRenderer.invoke('conversation-servers:unread', serverId) as { channels?: { channelId?: string; unreadCount?: number; mentionCount?: number; unread?: number; mentions?: number }[] };
  if (selectedServer.value === serverId) unreadByChannel.value = Object.fromEntries((result.channels ?? []).filter(item => item.channelId).map(item => [item.channelId!, item]));
}
function currentTarget(): ConversationChannelTarget { return { serverId: selectedServer.value, channelId: selectedChannel.value }; }
function currentDraft(): string { void composerRevision.value; return composer.draft(currentTarget()); }
function updateComposerDraft(event: Event): void {
  const textarea = event.currentTarget as HTMLTextAreaElement;
  composer.updateDraft({ serverId: textarea.dataset.serverId ?? '', channelId: textarea.dataset.channelId ?? '' }, textarea.value);
  composerRevision.value += 1;
}
function insertMention(userId: string): void {
  const target = currentTarget();
  const body = composer.draft(target);
  composer.updateDraft(target, `${body}${body && !body.endsWith(' ') ? ' ' : ''}${domain.mentionToken(userId)} `);
  composerRevision.value += 1;
}
async function sendFromComposer(form: HTMLFormElement): Promise<void> {
  const textarea = form.querySelector('textarea');
  if (!textarea) return;
  const submission = composer.capture({ serverId: form.dataset.serverId ?? '', channelId: form.dataset.channelId ?? '' }, textarea.value);
  if (!submission || sending.value) return;
  sending.value = true;
  try {
    await ipcRenderer.invoke('conversation-servers:send-message', { serverId: submission.serverId, channelId: submission.channelId, body: submission.body });
    composer.clearAfterSend(submission);
    composerRevision.value += 1;
    if (selectedServer.value === submission.serverId && selectedChannel.value === submission.channelId) await loadMessages(undefined, submission);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not send message'; }
  finally { sending.value = false; }
}
function unreadLabel(item: ConversationChannel): string { const data = unreadByChannel.value[item.id]; if (!data || item.notificationLevel === 'nothing') return ''; const count = item.notificationLevel === 'mentions' ? (data.mentionCount ?? data.mentions ?? 0) : (data.unreadCount ?? data.unread ?? 0); return domain.badge(item.notificationLevel, data.unreadCount ?? data.unread ?? 0, data.mentionCount ?? data.mentions ?? 0); }
const liveUpdateHandler = new ConversationServersLiveUpdateHandler({
  selectedChannelId: () => selectedChannel.value,
  hasChannel: channelId => channels.value.some(item => item.id === channelId),
  refreshMessages: () => loadMessages(),
  refreshUnread: () => loadUnread(),
});
function onChannelChanged(_event: Electron.IpcRendererEvent, update: { channelId: string }): void { void liveUpdateHandler.refresh(update?.channelId).catch(cause => { error.value = cause instanceof Error ? cause.message : 'Could not refresh conversations'; }); }
watch(() => [selectedServer.value, selectedChannel.value], () => { messages.value = []; if (channel.value) void loadMessages().catch(cause => { error.value = cause instanceof Error ? cause.message : 'Could not load messages'; }); });
function serverDefault(): NotificationLevel { return server.value?.notificationDefault ?? 'all'; }
function selectServer(serverId: string): void {
  selectedServer.value = serverId;
  channels.value = []; members.value = []; memberNames.value = []; orgMembers.value = []; selectedChannel.value = '';
  void load();
}
function openDiscover(): void { discoverQuery.value = ''; discoverOpen.value = true; }
function openDiscoveredServer(serverId: string): void { discoverOpen.value = false; selectServer(serverId); }
function openCreate(): void { createName.value = ''; createVisibility.value = 'public'; createOrgId.value = organizations.value[0]?.orgId ?? ''; createOpen.value = true; }
async function createServer(): Promise<void> {
  const name = createName.value.trim();
  if (!name || creating.value || (createVisibility.value === 'organization' && !createOrgId.value)) return;
  creating.value = true; error.value = '';
  try {
    const input = createVisibility.value === 'organization'
      ? { name, visibility: 'organization' as const, orgId: createOrgId.value }
      : { name, visibility: 'public' as const };
    const result = await ipcRenderer.invoke('conversation-servers:create', input) as ConversationServer | { server?: ConversationServer };
    const created = 'server' in result ? result.server : result;
    createOpen.value = false;
    await load();
    if (created?.id) selectServer(created.id);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not create server'; }
  finally { creating.value = false; }
}
function showDirectMessages(): void {
  selectedServer.value = '';
  channels.value = []; members.value = []; memberNames.value = []; orgMembers.value = []; selectedChannel.value = '';
}
async function setDefault(level: NotificationLevel): Promise<void> {
  if (!server.value) return;
  try { await ipcRenderer.invoke('conversation-servers:set-default', { serverId: server.value.id, level }); await load(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not update server notifications'; }
}
async function setChannelOverride(level: NotificationLevel | null): Promise<void> {
  if (!server.value || !channel.value || !canManageServer.value) return;
  try { await ipcRenderer.invoke('conversation-servers:set-channel-override', { serverId: server.value.id, channelId: channel.value.id, level }); await load(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not update channel notification default'; }
}
async function setChannel(level: NotificationLevel | null): Promise<void> {
  if (!server.value || !channel.value || channel.value.notificationAvailable === false) return;
  try { await ipcRenderer.invoke('conversation-servers:set-channel-notification', { serverId: server.value.id, channelId: channel.value.id, level }); await load(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not update notifications'; }
}
function displayName(id: string): string { return memberNames.value.find(person => person.userId === id)?.displayName ?? id; }
watch(() => props.orgId, () => { channels.value = []; members.value = []; memberNames.value = []; orgMembers.value = []; selectedServer.value = ''; selectedChannel.value = ''; void load(); });
onMounted(() => { ipcRenderer.on('conversation-servers:changed', onChannelChanged); void load(); });
onBeforeUnmount(() => ipcRenderer.removeListener('conversation-servers:changed', onChannelChanged));
</script>

<template>
  <section class="cs-shell" :class="{ 'has-server': !!server }" aria-label="Conversations">
    <nav class="cs-rail" aria-label="Servers">
      <button class="cs-server-icon cs-dm" :class="{ selected: !selectedServer }" title="Direct messages and People" aria-label="Direct messages and People" @click="showDirectMessages">DM</button>
      <span class="cs-divider" />
      <span class="cs-group">Public</span>
      <button v-for="item in publicServers" :key="item.id" class="cs-server-icon cs-public" :class="{ selected: selectedServer === item.id }" :title="item.name" :aria-label="`${item.name} server`" @click="selectServer(item.id)">{{ item.name.slice(0, 2).toUpperCase() }}</button>
      <button class="cs-discover" title="Discover public servers" aria-label="Discover public servers" @click="openDiscover"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m15.8 8.2-2.6 5-5 2.6 2.6-5z" /></svg></button>
      <span v-if="organizationServers.length" class="cs-divider" />
      <span v-if="organizationServers.length" class="cs-group">Orgs</span>
      <button v-for="item in organizationServers" :key="item.id" class="cs-server-icon cs-org" :class="{ selected: selectedServer === item.id }" :title="item.name" :aria-label="`${item.name} server`" @click="selectServer(item.id)">{{ item.name.slice(0, 2).toUpperCase() }}</button>
      <button class="cs-server-add" aria-label="Create server" title="Create server" @click="openCreate">+</button>
      <span v-if="loading" class="cs-loading" aria-live="polite">…</span>
      <button class="cs-exit" title="Back" aria-label="Back" @click="$emit('exit')"><span aria-hidden="true">↩</span><small>Exit</small></button>
    </nav>
    <div v-if="discoverOpen" class="cs-dialog-backdrop" @click.self="discoverOpen = false">
      <section class="cs-discover-dialog" role="dialog" aria-modal="true" aria-label="Discover public servers" @keydown.esc.stop="discoverOpen = false">
        <header><div><h2>Discover public servers</h2><p>Search public servers. Organization servers are not listed.</p></div><button type="button" aria-label="Close discovery" @click="discoverOpen = false">×</button></header>
        <label class="cs-discover-search">Search public servers<input v-model="discoverQuery" type="search" placeholder="Search servers" autofocus /></label>
        <ul v-if="discoveredServers.length" class="cs-discover-results">
          <li v-for="item in discoveredServers" :key="item.id"><button type="button" @click="openDiscoveredServer(item.id)"><span class="cs-discover-icon" aria-hidden="true">{{ item.name.slice(0, 2).toUpperCase() }}</span><span>{{ item.name }}</span><span class="cs-discover-open">Open</span></button></li>
        </ul>
        <p v-else class="cs-muted" role="status">No public servers match your search.</p>
        <p class="cs-muted">If a server isn’t accessible to you, membership is required to open it.</p>
      </section>
    </div>
    <div v-if="createOpen" class="cs-dialog-backdrop" @click.self="createOpen = false">
      <form class="cs-create-dialog" aria-label="Create server" @submit.prevent="void createServer()">
        <h2>Create a server</h2>
        <label>Server name<input v-model="createName" maxlength="100" required autofocus /></label>
        <label>Visibility<select v-model="createVisibility"><option value="public">Public</option><option value="organization" :disabled="!organizations.length">Organization</option></select></label>
        <label v-if="createVisibility === 'organization'">Organization<select v-model="createOrgId" required><option v-for="org in organizations" :key="org.orgId" :value="org.orgId">{{ org.name }}</option></select></label>
        <div><button type="button" @click="createOpen = false">Cancel</button><button :disabled="creating || !createName.trim() || (createVisibility === 'organization' && !createOrgId)">{{ creating ? 'Creating…' : 'Create server' }}</button></div>
      </form>
    </div>
    <slot v-if="!server" />
    <template v-else>
    <aside class="cs-channel-list" aria-label="Channels">
      <header><b>{{ server?.name ?? 'Servers' }}</b><small>{{ server?.visibility === 'organization' ? 'Organization server' : 'Public server' }}</small></header>
      <button v-if="server && canManageServer" class="cs-default" @click="openMenu = openMenu === 'default' ? '' : 'default'">Server default · {{ levels.find(level => level.id === server.notificationDefault)?.label ?? 'All messages' }}</button>
      <div v-if="openMenu === 'default'" class="cs-menu" role="group" aria-label="Server default notifications"><button v-for="level in levels" :key="level.id" @click="openMenu = ''; void setDefault(level.id)">{{ level.label }}</button></div>
      <div v-for="item in channels" :key="item.id" class="cs-channel" :class="{ active: selectedChannel === item.id }">
        <button class="cs-channel-select" :aria-label="`${item.name}, notifications ${levels.find(level => level.id === item.notificationLevel)?.label ?? 'All messages'}`" @click="selectedChannel = item.id"><span aria-hidden="true">{{ item.private ? '▣' : item.kind === 'a2a' ? '↔' : item.kind === 'announcement' ? '▤' : '#' }}</span><span>{{ item.name }}</span><small v-if="unreadLabel(item)" class="cs-badge">{{ unreadLabel(item) }}</small></button>
        <button class="cs-bell" :disabled="item.notificationAvailable === false" :aria-label="item.notificationAvailable === false ? `Join ${server?.name} to change notification settings` : `Notification settings for ${item.name}`" aria-haspopup="menu" :aria-expanded="openMenu === item.id" @click.stop="selectedChannel = item.id; openMenu = openMenu === item.id ? '' : item.id"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg></button>
      </div>
      <div v-if="openMenu && openMenu !== 'default'" class="cs-menu" role="group" aria-label="Channel notifications"><strong>{{ channel?.notificationPreference ? 'Your channel override' : channel?.notificationOverride ? `Using channel default · ${levels.find(level => level.id === channel.notificationOverride)?.label}` : `Using server default · ${levels.find(level => level.id === server?.notificationDefault)?.label}` }}</strong><button v-for="level in levels" :key="level.id" role="menuitemradio" :aria-checked="channel?.notificationLevel === level.id" @click="openMenu = ''; void setChannel(level.id)">{{ level.label }}</button><button @click="openMenu = ''; void setChannel(null)">Reset your preference</button><template v-if="canManageServer"><strong>Channel default</strong><button v-for="level in levels" :key="`override-${level.id}`" role="menuitemradio" :aria-checked="channel?.notificationOverride === level.id" @click="openMenu = ''; void setChannelOverride(level.id)">{{ level.label }}</button><button @click="openMenu = ''; void setChannelOverride(null)">Clear channel default</button></template></div>
      <p v-if="!channels.length && !loading" class="cs-muted">No channels</p>
      <p v-if="error" class="cs-error" role="alert">{{ error }}</p>
    </aside>
    <main class="cs-content">
      <header><b>{{ channel ? `${channel.kind === 'text' ? '#' : channel.kind === 'a2a' ? '↔' : '▤'} ${channel.name}` : 'Select a channel' }}</b><span>{{ channel?.private ? 'Private channel' : channel?.kind === 'a2a' ? 'Agent-to-agent channel' : channel?.kind === 'announcement' ? 'Announcements' : '' }}</span></header>
      <section v-if="channel" class="cs-timeline" aria-label="Channel messages">
        <button v-if="messages.length >= 50" class="cs-older" :disabled="loadingOlder" @click="loadingOlder = true; void loadMessages(messages[0]?.seq).finally(() => loadingOlder = false)">Load older messages</button>
        <p v-if="!messages.length" class="cs-muted">No messages yet</p>
        <article v-for="message in messages" :key="message.id" class="cs-message"><b>{{ displayName(message.authorUserId) }}</b><p>{{ message.body }}</p><small>#{{ message.seq }}</small></article>
        <form class="cs-composer" :data-server-id="selectedServer" :data-channel-id="selectedChannel" @submit.prevent="void sendFromComposer($event.currentTarget as HTMLFormElement)"><textarea :value="currentDraft()" :data-server-id="selectedServer" :data-channel-id="selectedChannel" maxlength="4000" aria-label="Message" placeholder="Message this channel" @input="updateComposerDraft" @keydown.enter.exact.prevent="void sendFromComposer(($event.currentTarget as HTMLTextAreaElement).form!)"/><div class="cs-compose-tools"><select aria-label="Insert member mention" @change="($event.target as HTMLSelectElement).value && insertMention(($event.target as HTMLSelectElement).value)"><option value="">Mention a member…</option><option v-for="member in visibleMembers" :key="member.userId" :value="member.userId">{{ displayName(member.userId) }}</option></select><button :disabled="!currentDraft().trim() || sending">Send</button></div></form>
      </section>
      <aside class="cs-members"><b>Members · {{ visibleMembers.length }}</b><div v-for="member in visibleMembers" :key="member.userId">{{ displayName(member.userId) }} <small v-if="member.role">{{ member.role }}</small></div></aside>
    </main>
    </template>
  </section>
</template>

<style scoped>
.cs-shell{display:grid;grid-template-columns:62px 240px minmax(300px,1fr);position:absolute;inset:0;background:var(--bg,#17191d);color:var(--text,#eee);z-index:5;font:13px system-ui}.cs-rail{display:flex;flex-direction:column;align-items:center;gap:9px;padding:12px 8px;background:var(--surface-1,#202329);border-right:1px solid var(--border,#363a43)}.cs-server-icon{position:relative;width:40px;height:40px;border:0;border-radius:14px;background:var(--surface-2,#2b2f36);color:var(--text-muted,#bec3cb);font-weight:700;cursor:pointer}.cs-server-icon.selected{border-radius:12px;box-shadow:0 0 0 2px var(--surface-1,#202329),0 0 0 4px var(--accent,#5096b3)}.cs-server-icon.selected::before{content:"";position:absolute;left:-11px;width:3px;height:28px;border-radius:0 3px 3px 0;background:var(--accent,#5096b3)}.cs-dm{border-radius:50%;background:var(--surface-2,#2b2f36)}.cs-channel-list{position:relative;padding:14px 10px;background:var(--surface-1,#202329);border-right:1px solid var(--border,#363a43);overflow:auto}.cs-channel-list header,.cs-content>header{display:flex;flex-direction:column;padding:4px 8px 14px;border-bottom:1px solid var(--border,#363a43)}.cs-channel-list small,.cs-content header span{color:var(--text-muted,#a4a9b2);margin-top:4px}.cs-default,.cs-channel,.cs-menu button{width:100%;border:0;background:none;color:inherit;text-align:left;padding:9px 8px;border-radius:6px;cursor:pointer}.cs-default{color:var(--text-muted,#a4a9b2);font-size:11px}.cs-channel{display:flex;align-items:center;gap:8px;color:var(--text-muted,#a4a9b2);border-radius:6px}.cs-channel.active{background:var(--surface-2,#2b2f36);color:var(--text,#eee)}.cs-channel-select{display:flex;gap:8px;align-items:center;flex:1;padding:9px 8px;border:0;background:none;color:inherit;text-align:left;cursor:pointer}.cs-bell{color:inherit;border:0;background:none;cursor:pointer;padding:5px}.cs-bell svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;display:block}.cs-bell:disabled{opacity:.4;cursor:not-allowed}.cs-menu{padding:4px;background:var(--surface-2,#2b2f36);border:1px solid var(--border,#363a43);border-radius:7px}.cs-menu button:hover,.cs-channel:hover{background:var(--surface-3,#393e47)}.cs-content{position:relative;min-width:0;display:grid;grid-template-columns:minmax(0,1fr) 220px}.cs-content>header{grid-column:1/-1;display:block;padding:16px 18px}.cs-content>header span{margin-left:12px}.cs-empty{padding:22px}.cs-timeline{padding:12px 18px 18px;overflow:auto;display:flex;flex-direction:column;gap:10px}.cs-message{padding:10px;border-bottom:1px solid var(--border,#363a43)}.cs-message p{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}.cs-message small{color:var(--text-dim,#888)}.cs-composer{margin-top:auto;padding:12px;border:1px solid var(--border,#363a43);border-radius:8px}.cs-composer textarea{width:100%;min-height:64px;resize:vertical;background:transparent;color:inherit;border:0;font:inherit}.cs-compose-tools{display:flex;justify-content:space-between}.cs-compose-tools select,.cs-compose-tools button,.cs-older{background:var(--surface-2,#2b2f36);color:inherit;border:1px solid var(--border,#363a43);border-radius:5px;padding:7px}.cs-badge{margin-left:auto;color:var(--accent,#5096b3)}.cs-empty p,.cs-muted{color:var(--text-muted,#a4a9b2)}.cs-members{padding:16px 12px;border-left:1px solid var(--border,#363a43);color:var(--text-muted,#a4a9b2)}.cs-members>b{display:block;color:var(--text,#eee);margin-bottom:12px}.cs-members div{padding:5px 0}.cs-members small{float:right}.cs-error{color:var(--danger,#f66)}@media(max-width:900px){.cs-shell{grid-template-columns:56px 200px minmax(220px,1fr)}.cs-content{grid-template-columns:minmax(0,1fr)}.cs-members{display:none}}
.cs-shell{--cs-rail-width:72px;--cs-channel-width:244px;--cs-active:#3a7fa0;position:relative;z-index:2;display:grid;grid-template-columns:var(--cs-rail-width) minmax(0,1fr);width:100%;height:100%;min-height:0;overflow:hidden;background:var(--paper,#f4f7fb);color:var(--text,#1a2332);font:13px var(--sans,system-ui)}
.cs-discover{display:grid;place-items:center;width:40px;height:40px;border:0;border-radius:14px;background:transparent;color:var(--dim,#8a94a3);cursor:pointer}.cs-discover:hover,.cs-discover:focus-visible{background:var(--ink-05,rgba(26,35,50,.05));color:var(--muted,#5b6778)}.cs-discover svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.cs-discover-dialog{display:grid;gap:12px;width:min(480px,calc(100% - 32px));max-height:min(620px,calc(100% - 32px));overflow:auto;padding:22px;border:1px solid var(--line-2,rgba(26,35,50,.14));border-radius:12px;background:var(--card-solid,#fff);box-shadow:0 16px 48px rgba(26,35,50,.2)}.cs-discover-dialog>header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:0 0 12px;border-bottom:1px solid var(--line,rgba(26,35,50,.09))}.cs-discover-dialog h2,.cs-discover-dialog p{margin:0}.cs-discover-dialog h2{font-size:18px}.cs-discover-dialog header p{margin-top:5px;color:var(--muted,#5b6778)}.cs-discover-dialog header button{border:0;background:transparent;color:var(--muted,#5b6778);font-size:22px;cursor:pointer}.cs-discover-search{display:grid;gap:6px;color:var(--muted,#5b6778)}.cs-discover-search input{padding:10px;border:1px solid var(--line-2,rgba(26,35,50,.16));border-radius:6px;background:var(--paper,#f4f7fb);color:var(--text,#1a2332);font:inherit}.cs-discover-results{display:grid;gap:4px;margin:0;padding:0;list-style:none}.cs-discover-results button{display:flex;align-items:center;gap:10px;width:100%;padding:8px;border:0;border-radius:7px;background:transparent;color:var(--text,#1a2332);text-align:left;cursor:pointer}.cs-discover-results button:hover,.cs-discover-results button:focus-visible{background:var(--paper-2,#eaf0f6)}.cs-discover-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:color-mix(in srgb,var(--accent,#3a7fa0) 11%,var(--card-solid,#fff));color:var(--accent-2,#2f6a86);font-weight:700}.cs-discover-open{margin-left:auto;color:var(--accent-2,#2f6a86)}.cs-server-add{width:40px;height:40px;border:1px dashed var(--line-2,rgba(26,35,50,.2));border-radius:14px;background:transparent;color:var(--muted,#5b6778);font-size:23px;cursor:pointer}.cs-server-add:hover{border-color:var(--cs-active);color:var(--cs-active)}.cs-dialog-backdrop{position:absolute;inset:0;z-index:8;display:grid;place-items:center;background:rgba(20,28,38,.32)}.cs-create-dialog{display:grid;gap:14px;width:min(360px,calc(100% - 32px));padding:22px;border:1px solid var(--line-2,rgba(26,35,50,.14));border-radius:12px;background:var(--card-solid,#fff);box-shadow:0 16px 48px rgba(26,35,50,.2)}.cs-create-dialog h2{margin:0;font-size:18px}.cs-create-dialog label{display:grid;gap:6px;color:var(--muted,#5b6778)}.cs-create-dialog input,.cs-create-dialog select{padding:9px;border:1px solid var(--line-2,rgba(26,35,50,.16));border-radius:6px;background:var(--paper,#f4f7fb);color:var(--text,#1a2332);font:inherit}.cs-create-dialog>div{display:flex;justify-content:flex-end;gap:8px}.cs-create-dialog button{padding:8px 12px;border:1px solid var(--line-2,rgba(26,35,50,.16));border-radius:6px;background:var(--paper-2,#eaf0f6);color:var(--text,#1a2332);cursor:pointer}.cs-create-dialog button[type=submit]{background:var(--cs-active);color:white}.cs-create-dialog button:disabled{opacity:.55;cursor:not-allowed}
.cs-shell.has-server{grid-template-columns:var(--cs-rail-width) var(--cs-channel-width) minmax(0,1fr)}
.cs-rail{gap:8px;min-height:0;overflow-y:auto;padding:12px 0;background:var(--paper-2,#eaf0f6);border-color:var(--line,rgba(26,35,50,.09))}.cs-group{font-size:9px;font-weight:700;letter-spacing:.08em;color:var(--dim,#8a94a3);text-transform:uppercase;margin-top:4px}.cs-divider{width:32px;height:2px;border-radius:2px;background:var(--line-2,rgba(26,35,50,.14));margin:2px 0}
.cs-server-icon{flex:none;width:44px;height:44px;background:var(--card-solid,#fff);color:#3d4b59;box-shadow:0 1px 1px rgba(26,35,50,.04),0 2px 8px -2px rgba(26,35,50,.08);transition:border-radius .15s}.cs-server-icon:hover{border-radius:11px}.cs-server-icon.selected{border-radius:11px;box-shadow:0 0 0 2px var(--paper,#f4f7fb),0 0 0 4px var(--cs-active)}.cs-server-icon.selected::before{left:-14px;top:50%;width:4px;height:32px;margin-top:-16px;background:var(--cs-active)}.cs-dm{background:#cfd8e0}.cs-public{background:color-mix(in srgb,var(--accent,#3a7fa0) 11%,var(--card-solid,#fff));color:var(--accent-2,#2f6a86)}.cs-org{background:color-mix(in srgb,#8394a5 15%,var(--card-solid,#fff));color:#526273}
.cs-loading{color:var(--dim,#8a94a3)}.cs-exit{display:grid;place-items:center;gap:2px;margin-top:auto;width:50px;padding:6px 0;border:0;border-radius:9px;background:transparent;color:var(--muted,#5b6778);font-size:18px}.cs-exit:hover{background:var(--ink-05,rgba(26,35,50,.05));color:var(--text,#1a2332)}.cs-exit small{font-size:10px}
.cs-channel-list{background:var(--nav-bg,rgba(255,255,255,.55));border-color:var(--line,rgba(26,35,50,.09))}.cs-channel-list header,.cs-content>header{border-color:var(--line,rgba(26,35,50,.09))}.cs-channel-list small,.cs-content header span{color:var(--muted,#5b6778)}.cs-channel{color:var(--muted,#5b6778)}.cs-channel.active{background:var(--accent-soft,rgba(58,127,160,.1));color:var(--accent-2,#2f6a86)}.cs-channel-select{padding:2px 0}.cs-content{min-height:0;grid-template-columns:minmax(0,1fr) 264px;background:var(--paper,#f4f7fb)}.cs-content>header{padding:16px 18px}.cs-timeline{min-height:0}.cs-message{border-color:var(--line,rgba(26,35,50,.09))}.cs-message small{color:var(--dim,#8a94a3)}.cs-composer{border-color:var(--line-2,rgba(26,35,50,.14));background:var(--card-solid,#fff)}.cs-compose-tools select,.cs-compose-tools button,.cs-older{background:var(--paper-2,#eaf0f6);border-color:var(--line-2,rgba(26,35,50,.14))}.cs-members{background:var(--nav-bg,rgba(255,255,255,.55));border-color:var(--line,rgba(26,35,50,.09))}.cs-members>b{color:var(--text,#1a2332)}.cs-shell>:slotted(.app){grid-column:2;min-width:0;min-height:0;width:100%;height:100%}
@media(max-width:1000px){.cs-shell{--cs-rail-width:64px;--cs-channel-width:205px}.cs-content{grid-template-columns:minmax(0,1fr)}.cs-members{display:none}}
</style>
