<!-- Sulla Desktop · https://sulladesktop.com | Copyright (c) 2025-2026 Merchant Protocol LLC. | SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ipcRenderer, webUtils } from 'electron';

type Attachment = { name: string; path: string; size: number };
type UpdateState = { phase: string; currentVersion: string; availableVersion?: string; channel: 'lts' | 'nightly'; pinnedVersion?: string; lastUpdateResult?: { previousVersion: string; newVersion: string; channel: 'lts' | 'nightly'; completedAt: string } };
type Message = { id: string; createdAt: string; body: string; sender?: 'user' | 'support'; attachments: Attachment[] };
type Ticket = Message & { subject: string; status?: string; replies: Message[] };
type Activity = { id: string; tool: string; summary: string; inputSummary: Record<string, unknown>; status: string; startedAt: string; completedAt?: string; durationMs?: number };
type State = { logging: { sources: Record<string, boolean>; autoEnabledUntil?: string; lastErrorAt?: string }; feedback: Message[]; tickets: Ticket[]; privacy: { errorReports: boolean; metricsConsent: boolean; autoAttachLogs: boolean }; remote: { status: string; message?: string; requestedAt?: string; offeredAt?: string; offeredBy?: string; approvedAt?: string; expiresAt?: string; endedAt?: string; endReason?: string; activity: Activity[] } };

const sections = ['home', 'logs', 'feedback', 'tickets', 'remote', 'privacy'] as const;
const labels: Record<string, string> = { home: 'Support Center', logs: 'Logs', feedback: 'Feedback', tickets: 'Tickets', remote: 'Remote support', privacy: 'Privacy' };
const icons: Record<string, string> = { home: '⌂', logs: '≡', feedback: '◇', tickets: '▱', remote: '↗', privacy: '♢' };
const section = ref('home');
const state = ref<State | null>(null);
const updateState = ref<UpdateState | null>(null);
const updateNoticeDismissed = ref(false);
const logs = ref<any[]>([]);
const remoteMessage = ref('');
const busy = ref(false);
const notice = ref('');
const signedIn = ref(true);
const unread = ref(0);
const feedbackBody = ref('');
const feedbackFiles = ref<Attachment[]>([]);
const feedbackKind = ref('Bug');
const subject = ref('');
const ticketBody = ref('');
const ticketFiles = ref<Attachment[]>([]);
const selectedTicket = ref('');
const replyBody = ref('');
const replyFiles = ref<Attachment[]>([]);
const dragging = ref(false);
// Templates auto-unwrap refs, so callers pass a list key and we look the ref up here.
const fileLists = { feedback: feedbackFiles, ticket: ticketFiles, reply: replyFiles };
type AttachmentList = keyof typeof fileLists;
// IPC uses structured clone, which cannot copy Vue's reactive proxies.
const plain = (list: Attachment[]) => list.map(({ name, path, size }) => ({ name, path, size }));
const sourceLabels: Record<string, [string, string]> = {
  desktop: ['App', 'Sulla Desktop main and window processes'],
  runtime: ['Runtime VM', 'Boot, disk and network'],
  containers: ['Containers', 'Sulla services and their health'],
  ai: ['AI connections', 'Claude, Codex and local models'],
};
const currentTicket = computed(() => state.value?.tickets.find(ticket => ticket.id === selectedTicket.value) || state.value?.tickets[0]);
const remoteCopy = computed(() => ({
  idle: ['Remote support is off', 'Request help when setup or Sulla is not working. Nothing connects until support accepts and you approve.'],
  waiting: ['Waiting for Sulla support', 'Your request is in the queue. You can close this window or restart Sulla; this state is saved locally.'],
  approval: ['One-time approval needed', `${ state.value?.remote.offeredBy || 'Sulla support' } is ready to connect. Review the limits before approving.`],
  connected: ['Support is connected', 'Every support action runs only inside the Sulla runtime and appears in the activity log below.'],
  ended: ['Remote support ended', 'Access has been removed. Nothing remains connected.'],
} as Record<string, [string, string]>)[state.value?.remote.status || 'idle']);

function navigate(value: string) {
  section.value = sections.includes(value as any) ? value : 'home';
  if (section.value === 'logs') { void loadLogs() }
}
function fromHash() { navigate(location.hash.slice(1).split('?')[0]) }
async function refresh() {
  state.value = await ipcRenderer.invoke('support:state');
  updateState.value = await ipcRenderer.invoke('support:update-status');
  signedIn.value = (await ipcRenderer.invoke('support:cloud-status')).signedIn;
  if (signedIn.value) {
    try { [state.value.tickets, unread.value] = await Promise.all([ipcRenderer.invoke('support:tickets'), ipcRenderer.invoke('support:unread')]); } catch (error) { notice.value = error instanceof Error ? error.message : String(error) }
  }
  if (!selectedTicket.value && state.value?.tickets[0]) { selectedTicket.value = state.value.tickets[0].id }
}
async function loadLogs() { logs.value = await ipcRenderer.invoke('support:logs') }
async function setSource(key: string, enabled: boolean) { state.value = await ipcRenderer.invoke('support:set-source', key, enabled); await loadLogs() }
function addFiles(list: AttachmentList, added: Attachment[]) { const target = fileLists[list]; const merged = [...target.value, ...added].filter((file, index, all) => all.findIndex(other => other.path === file.path) === index); if (merged.length > 10) notice.value = 'Only the first 10 attachments were kept.'; target.value = merged.slice(0, 10) }
async function choose(list: AttachmentList) { try { addFiles(list, await ipcRenderer.invoke('support:choose-files')) } catch (error) { notice.value = error instanceof Error ? error.message : String(error) } }
async function dropFiles(list: AttachmentList, event: DragEvent) {
  dragging.value = false;
  const paths = Array.from(event.dataTransfer?.files || [], file => webUtils.getPathForFile(file)).filter(Boolean);
  if (!paths.length) return;
  try { addFiles(list, await ipcRenderer.invoke('support:attach-paths', paths.slice(0, 10))) } catch (error) { notice.value = error instanceof Error ? error.message : String(error) }
}
function remove(list: AttachmentList, index: number) { fileLists[list].value.splice(index, 1) }
// Stop Electron from navigating to a file dropped outside a drop zone.
const blockStrayDrop = (event: DragEvent) => event.preventDefault();
async function submitFeedback() {
  busy.value = true;
  try {
    state.value = await ipcRenderer.invoke('support:add-feedback', { body: `[${ feedbackKind.value }] ${ feedbackBody.value }`, attachments: plain(feedbackFiles.value) });
    feedbackBody.value = ''; feedbackFiles.value = []; notice.value = 'Feedback sent to Sulla support.';
  } catch (error) { notice.value = error instanceof Error ? error.message : String(error) } finally { busy.value = false }
}
async function createTicket() {
  busy.value = true;
  try {
    state.value = await ipcRenderer.invoke('support:create-ticket', { subject: subject.value, body: ticketBody.value, attachments: plain(ticketFiles.value) });
    selectedTicket.value = state.value!.tickets[0].id; subject.value = ''; ticketBody.value = ''; ticketFiles.value = []; notice.value = 'Ticket sent to Sulla support.';
  } catch (error) { notice.value = error instanceof Error ? error.message : String(error) } finally { busy.value = false }
}
async function replyTicket() {
  if (!currentTicket.value) { return }
  busy.value = true;
  try {
    const updated = await ipcRenderer.invoke('support:reply-ticket', { ticketId: currentTicket.value.id, body: replyBody.value, attachments: plain(replyFiles.value) });
    const index = state.value!.tickets.findIndex(ticket => ticket.id === updated.id); if (index >= 0) state.value!.tickets[index] = updated;
    replyBody.value = ''; replyFiles.value = [];
  } catch (error) { notice.value = error instanceof Error ? error.message : String(error) } finally { busy.value = false }
}
async function remote(action: string) {
  busy.value = true; notice.value = '';
  try { state.value = await ipcRenderer.invoke('support:remote', action, action === 'request' ? remoteMessage.value : undefined); if (action === 'request') remoteMessage.value = ''; }
  catch (error) { notice.value = error instanceof Error ? error.message : String(error) }
  finally { busy.value = false }
}
async function setPrivacy(key: string, enabled: boolean) { state.value = await ipcRenderer.invoke('support:set-privacy', key, enabled) }
async function installUpdate() { updateNoticeDismissed.value = false; await ipcRenderer.invoke('support:update-install') }
async function sendLogs() { try { const ticket = await ipcRenderer.invoke('support:send-logs', currentTicket.value?.id); notice.value = `Logs sent on ticket ${ ticket.id }.`; await refresh() } catch (error) { notice.value = error instanceof Error ? error.message : String(error) } }
async function downloadLogs() { try { if (await ipcRenderer.invoke('support:download-logs')) notice.value = 'Logs downloaded.' } catch (error) { notice.value = error instanceof Error ? error.message : String(error) } }
const onUpdateState = (_: unknown, value: UpdateState) => { updateState.value = value; updateNoticeDismissed.value = false };
const pretty = (value?: string) => value ? new Date(value).toLocaleString() : '';
const size = (value: number) => value < 1048576 ? `${ Math.max(1, Math.round(value / 1024)) } KB` : `${ (value / 1048576).toFixed(1) } MB`;
let timer: ReturnType<typeof setInterval>;
const onNavigate = (_: unknown, value: string) => navigate(value);
const onRemoteState = (_: unknown, remoteState: State['remote']) => { if (state.value) state.value.remote = remoteState };
onMounted(async() => { window.addEventListener('hashchange', fromHash); window.addEventListener('dragover', blockStrayDrop); window.addEventListener('drop', blockStrayDrop); ipcRenderer.on('support:navigate', onNavigate); ipcRenderer.on('support:remote-state', onRemoteState); ipcRenderer.on('updater:state', onUpdateState); fromHash(); await refresh(); timer = setInterval(() => { if (section.value === 'logs') { void loadLogs() } }, 3000) });
onBeforeUnmount(() => { clearInterval(timer); window.removeEventListener('hashchange', fromHash); window.removeEventListener('dragover', blockStrayDrop); window.removeEventListener('drop', blockStrayDrop); ipcRenderer.removeListener('support:navigate', onNavigate); ipcRenderer.removeListener('support:remote-state', onRemoteState); ipcRenderer.removeListener('updater:state', onUpdateState) });
</script>

<template>
  <div class="shell">
    <aside>
      <nav>
        <a v-for="item in sections" :key="item" :href="`#${item}`" :class="{ on: section === item }">
          <span class="navicon">{{ icons[item] }}</span>{{ labels[item] }}
          <em v-if="item === 'tickets' && unread">{{ unread }}</em>
          <i v-if="item === 'remote' && state?.remote.status === 'connected'" class="live-dot" />
        </a>
      </nav>
      <div class="sidefoot">
        <div class="mini device">
          <h3><span class="navicon">▰</span>This Mac</h3>
          <div><span>Sulla Desktop</span><b>{{ updateState?.currentVersion || "—" }}</b></div>
          <div><span>Update channel</span><b class="channel" :class="{ nightly: updateState?.channel === 'nightly' }">{{ updateState?.channel === 'nightly' ? 'Nightly' : 'LTS' }}</b></div>
          <div><span>Runtime VM</span><b class="healthy">Healthy</b></div>
        </div>
        <div class="mini privacy-note"><span>🔒</span>Support never sees your Files, passwords or chats.</div>
      </div>
    </aside>

    <main v-if="state">
      <div v-if="!signedIn" class="alert warn"><b>Sign in to Sulla Cloud</b><span>Tickets and feedback need your Cloud account. Nothing is queued while signed out.</span></div>
      <div v-if="state.remote.status === 'connected'" class="connection"><i class="live-dot" /><b>{{ state.remote.offeredBy || 'Sulla support' }} is connected</b><span>Inside your Sulla runtime only · reconnects after restarts</span><button @click="remote('end')">End support</button></div>
      <div class="page">
        <div v-if="notice" class="notice">{{ notice }}<button @click="notice = ''">×</button></div>
        <div v-if="updateState && !updateNoticeDismissed && updateState.channel === 'nightly' && updateState.phase === 'downloaded'" class="update-toast nightly-toast">
          <span class="update-icon">☾</span><div><h2>Support moved you to the Nightly channel for a fix</h2><p><b>{{ updateState.availableVersion }}</b> is downloaded and signature-checked.</p><p>Restart takes about a minute. Support reconnects on its own; you won't need to approve again.</p></div><div class="toast-actions"><button @click="updateNoticeDismissed = true">Later</button><button class="primary" @click="installUpdate">↻ Restart to update</button></div>
        </div>
        <div v-else-if="updateState && !updateNoticeDismissed && updateState.lastUpdateResult?.newVersion === updateState.currentVersion && updateState.channel === 'nightly' && updateState.lastUpdateResult?.channel === 'nightly'" class="update-toast success-toast">
          <span class="update-icon">✓</span><div><h2>Updated to the fix build</h2><p>You're on <b>Nightly {{ updateState.currentVersion }}</b>. Support reconnected and is checking that everything works.</p></div><div class="toast-actions"><button @click="updateNoticeDismissed = true">Dismiss</button></div>
        </div>
        <div v-else-if="updateState && !updateNoticeDismissed && updateState.channel === 'lts' && updateState.channel === 'nightly' && updateState.lastUpdateResult?.channel === 'nightly'" class="update-toast success-toast">
          <span class="update-icon">✓</span><div><h2>You're back on LTS</h2><p>The fix stays installed. You'll receive regular LTS updates automatically.</p></div><div class="toast-actions"><button class="primary" @click="updateNoticeDismissed = true">Done</button></div>
        </div>

        <section v-if="section === 'home'">
          <header><h1>Support Center</h1><p>Get help with Sulla Desktop. Everything here works even if setup didn't finish.</p></header>
          <div v-if="state.logging.lastErrorAt" class="alert warn"><div><b>Sulla hit an error at {{ pretty(state.logging.lastErrorAt) }}.</b><p>Logging turned on automatically for 24 hours so support can see what happened.</p></div><span class="push" /><a class="button" href="#logs">View logs</a><a class="button primary" href="#remote">Get remote help</a></div>
          <div class="tiles">
            <a href="#logs"><span class="tileicon">≡</span><h2>Logs</h2><p>See what Sulla is doing, turn logging on or off, and view redacted logs.</p><small><i class="dot warn-dot" />On automatically after an error</small></a>
            <a href="#feedback"><span class="tileicon">◇</span><h2>Send feedback</h2><p>Ideas, bugs or praise. Add screenshots or files.</p><small>Sent to Sulla support</small></a>
            <a href="#tickets"><span class="tileicon">▱</span><h2>Open a ticket</h2><p>Get a written answer and keep replies and attachments in one thread.</p><small><i class="dot accent-dot" />{{ state.tickets.length }} ticket(s)</small></a>
            <a href="#remote"><span class="tileicon">↗</span><h2>Remote support</h2><p>Let Sulla support diagnose your runtime after your approval.</p><small><i class="dot" :class="state.remote.status === 'connected' ? 'good-dot' : 'off-dot'" />{{ state.remote.status === 'idle' ? 'Not connected' : state.remote.status }}</small></a>
          </div>
          <div class="card privacy-card"><div class="cardhead"><span class="tileicon small">♢</span><h2>Privacy</h2><a href="#privacy">Review settings</a></div><div class="cardbody"><b>Error reports and support state stay separate from your vault.</b><p>Local support state lives in userData/support-state.json. No Files, chats, passwords or API keys are included.</p></div></div>
        </section>

        <section v-else-if="section === 'logs'">
          <header class="row"><div><h1>Logs</h1><p>Live logs from this Mac and your Sulla runtime. Credential-shaped fields are redacted.</p></div><div><button @click="loadLogs">Refresh</button> <button @click="sendLogs" :disabled="!signedIn">Send logs to support</button> <button class="primary" @click="downloadLogs">Download logs</button></div></header>
          <div class="alert"><span class="info">i</span><div><b>Logging turns on by itself after an error.</b><p>It stays on for 24 hours after the last error. Switch any source off at any time.</p></div></div>
          <div class="card"><div class="cardhead"><h2>Sources</h2><small v-if="state.logging.autoEnabledUntil">Auto-on until {{ pretty(state.logging.autoEnabledUntil) }}</small></div><div class="cardbody sources"><div v-for="(value, key) in sourceLabels" :key="key" class="source"><span class="sourceicon">{{ { desktop: 'S', runtime: 'VM', containers: '▦', ai: 'AI' }[key] }}</span><div><b>{{ value[0] }}</b><small>{{ value[1] }}</small></div><button class="toggle" :class="{ on: state.logging.sources[key] }" :aria-label="`Toggle ${value[0]}`" @click="setSource(key, !state.logging.sources[key])"><i /></button></div></div></div>
          <div class="terminal"><template v-if="logs.length"><div v-for="entry in logs" :key="entry.source + entry.name"><b>[{{ entry.source }} / {{ entry.name }}]</b>\n{{ entry.text }}</div></template><span v-else>No log entries found for enabled sources.</span></div>
        </section>

        <section v-else-if="section === 'feedback'">
          <header><h1>Send feedback</h1><p>Tell us what's working, what isn't, and what you wish Sulla did.</p></header>
          <div class="card form-card"><div class="cardbody">
            <label>What kind of feedback?</label><div class="chips"><button v-for="kind in ['Bug', 'Idea', 'Praise', 'Something else']" :key="kind" :class="{ on: feedbackKind === kind }" @click="feedbackKind = kind">{{ kind }}</button></div>
            <label>What would you like us to know?</label><textarea v-model="feedbackBody" maxlength="10000" placeholder="Tell us what happened or what could work better…" />
            <label>Attachments</label><button class="drop" :class="{ over: dragging }" @click="choose('feedback')" @dragenter.prevent="dragging = true" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="dropFiles('feedback', $event)"><b>＋</b><span>Drop files or <strong>choose files</strong></span></button>
            <div class="files"><div v-for="(file, index) in feedbackFiles" :key="file.path"><span class="fileicon">{{ file.name.split('.').pop()?.slice(0, 4).toUpperCase() }}</span><div><b>{{ file.name }}</b><small>{{ size(file.size) }}</small></div><button @click="remove('feedback', index)">×</button></div></div>
            <div class="actions"><small>Sent securely to Sulla Cloud. No vault access.</small><a class="button" href="#home">Cancel</a><button class="primary" :disabled="busy || !feedbackBody.trim() || !signedIn" @click="submitFeedback">Send feedback</button></div>
          </div></div>
        </section>

        <section v-else-if="section === 'tickets'">
          <header class="row"><div><h1>Tickets</h1><p>Create a ticket and keep replies and attachments in one thread.</p></div><button class="primary" @click="selectedTicket = '__new'">Open a ticket</button></header>
          <div class="ticketgrid">
            <nav class="ticketlist"><button v-for="ticket in state.tickets" :key="ticket.id" :class="{ on: ticket.id === currentTicket?.id && selectedTicket !== '__new' }" @click="selectedTicket = ticket.id"><b>{{ ticket.subject }}</b><small>{{ ticket.id }} · {{ ticket.replies.length }} replies</small><span>Open</span></button><div v-if="!state.tickets.length" class="empty">No tickets yet.<br>Open one to start a thread.</div></nav>
            <form v-if="selectedTicket === '__new' || !currentTicket" @submit.prevent="createTicket"><h2>Open a ticket</h2><label>Subject</label><input v-model="subject" maxlength="160" placeholder="What do you need help with?"><label>What happened?</label><textarea v-model="ticketBody" maxlength="10000" placeholder="Describe the problem" /><button type="button" @click="choose('ticket')" @dragover.prevent @drop.prevent="dropFiles('ticket', $event)">＋ Attach files</button><div class="files"><div v-for="(file, index) in ticketFiles" :key="file.path"><b>{{ file.name }}</b><button type="button" @click="remove('ticket', index)">×</button></div></div><div class="actions"><button class="primary" :disabled="busy || !subject.trim() || !ticketBody.trim() || !signedIn">Open ticket</button></div></form>
            <article v-else class="thread"><div class="threadhead"><div><h2>{{ currentTicket.subject }}</h2><small>{{ currentTicket.id }} · opened {{ pretty(currentTicket.createdAt) }}</small></div><span class="pill">{{ currentTicket.status || 'open' }}</span></div><div class="message"><span class="avatar you">You</span><div><b>You <small>· {{ pretty(currentTicket.createdAt) }}</small></b><p>{{ currentTicket.body }}</p><div v-if="currentTicket.attachments.length" class="attachment">📎 {{ currentTicket.attachments.map(file => file.name).join(', ') }}</div></div></div><div v-for="reply in currentTicket.replies" :key="reply.id" class="message" :class="{ staff: reply.sender === 'support' }"><span class="avatar" :class="{ you: reply.sender !== 'support' }">{{ reply.sender === 'support' ? 'S' : 'You' }}</span><div><b>{{ reply.sender === 'support' ? 'Sulla support' : 'You' }} <small>· {{ pretty(reply.createdAt) }}</small></b><p>{{ reply.body }}</p><div v-if="reply.attachments.length" class="attachment">📎 {{ reply.attachments.map(file => file.name).join(', ') }}</div></div></div><div class="composer"><textarea v-model="replyBody" placeholder="Reply…" /><div><button @click="choose('reply')" @dragover.prevent @drop.prevent="dropFiles('reply', $event)">＋ Attach</button><button class="primary" :disabled="busy || !replyBody.trim()" @click="replyTicket">Reply</button></div></div></article>
          </div>
        </section>

        <section v-else-if="section === 'remote'">
          <header v-if="state.remote.status !== 'waiting'"><h1>Remote support</h1><p>A Sulla engineer connects to your Sulla runtime, finds the problem and fixes it with you watching.</p></header>
          <div v-if="state.remote.status === 'approval'" class="approval card"><div class="approver">{{ (state.remote.offeredBy || 'Sulla support').split(' ').map(word => word[0]).join('').slice(0, 2) }}</div><div><h2>{{ state.remote.offeredBy || 'Sulla support' }} wants to connect</h2><p>Remote support request accepted {{ pretty(state.remote.offeredAt) }}</p></div></div>
          <div class="remote" :class="state.remote.status">
            <div class="status"><span v-if="state.remote.status === 'waiting'" class="spinner" /><span v-else>{{ state.remote.status === 'connected' || state.remote.status === 'ended' ? '✓' : '↗' }}</span></div><h1>{{ remoteCopy[0] }}</h1><p>{{ remoteCopy[1] }}</p><small>{{ pretty(state.remote.endedAt || state.remote.approvedAt || state.remote.offeredAt || state.remote.requestedAt) }}</small>
            <div v-if="state.remote.status === 'waiting'" class="request card"><div><span>Request</span><b>{{ state.remote.message }}</b></div><div><span>Status</span><b class="queue"><i class="dot accent-dot" />In the queue</b></div></div>
            <div class="scope"><div><h3 class="can">✓ Support can</h3><ul><li>Read Sulla's redacted logs</li><li>Diagnose and run commands inside your Sulla runtime VM</li><li>Check Sulla container health</li><li>Retry an AI connection after approval</li></ul></div><div><h3 class="cant">× Support can't</h3><ul><li>Run anything on your Mac</li><li>Open your Files or chats</li><li>See passwords or the vault</li><li>Stay connected after you end it</li></ul></div></div>
            <div v-if="['idle', 'ended'].includes(state.remote.status)" class="request-form card"><label>What do you need help with?</label><textarea v-model="remoteMessage" maxlength="4000" placeholder="Describe what isn't working…" /></div><div class="actions center"><button v-if="['idle', 'ended'].includes(state.remote.status)" class="primary" :disabled="busy || !remoteMessage.trim() || !signedIn" @click="remote('request')">Request remote support</button><button v-else-if="state.remote.status === 'waiting'" class="danger" @click="remote('end')">Cancel request</button><template v-else-if="state.remote.status === 'approval'"><button @click="remote('end')">Decline</button><button class="primary" @click="remote('approve')">Allow for up to 48 hours</button></template><button v-else-if="state.remote.status === 'connected'" class="danger" @click="remote('end')">End support access</button></div><small v-if="state.remote.status === 'connected'">Approval expires {{ pretty(state.remote.expiresAt) }}. The grant and activity log are saved locally.</small>
            <div v-if="state.remote.activity.length" class="activity card"><div class="cardhead"><h2>Live support activity</h2><small>Every command is shown here</small></div><details v-for="item in state.remote.activity" :key="item.id"><summary><i class="dot" :class="item.status === 'started' ? 'warn-dot' : item.status === 'succeeded' ? 'good-dot' : 'off-dot'" /><span><b>{{ item.summary }}</b><small>{{ pretty(item.startedAt) }} · {{ item.status.replace('_', ' ') }}</small></span><span>Details</span></summary><pre>{{ JSON.stringify({ tool: item.tool, arguments: item.inputSummary, durationMs: item.durationMs }, null, 2) }}</pre></details></div>
          </div>
        </section>

        <section v-else>
          <header><h1>Privacy</h1><p>See what support can collect. These controls never depend on the vault.</p></header>
          <div class="card settings"><div><span><b>Send error reports</b><small>Error message, stack trace, app version and OS. Never file contents, passwords, chats or API keys.</small></span><button class="toggle" :class="{ on: state.privacy.errorReports }" @click="setPrivacy('errorReports', !state.privacy.errorReports)"><i /></button></div><div><span><b>Share usage metrics</b><small>Setup milestones, versions and errors only, so support can see where setup stopped.</small></span><button class="toggle" :class="{ on: state.privacy.metricsConsent }" @click="setPrivacy('metricsConsent', !state.privacy.metricsConsent)"><i /></button></div><div><span><b>Attach logs to tickets automatically</b><small>Adds the last 30 minutes of locally redacted logs.</small></span><button class="toggle" :class="{ on: state.privacy.autoAttachLogs }" @click="setPrivacy('autoAttachLogs', !state.privacy.autoAttachLogs)"><i /></button></div></div>
        </section>
      </div>
    </main>
  </div>
</template>

<style scoped>
:global(*){box-sizing:border-box}:global(html),:global(body),:global(#app){height:100%}:global(body){margin:0;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;color:#1a2332;background:#f4f7fb}.shell{height:100%;display:grid;grid-template-columns:220px minmax(0,1fr);background:radial-gradient(800px 450px at 15% -10%,rgba(58,127,160,.1),transparent 60%),#f4f7fb}aside{min-height:0;padding:14px 12px 12px;border-right:1px solid rgba(26,35,50,.09);background:rgba(255,255,255,.68);display:flex;flex-direction:column}aside nav{display:flex;flex-direction:column;gap:2px}aside nav a{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:8px;color:#5b6778;text-decoration:none;font-weight:500}aside nav a:hover{background:rgba(26,35,50,.05);color:#1a2332}aside nav a.on{background:rgba(58,127,160,.11);color:#2f6a86;font-weight:600}.navicon{width:16px;text-align:center;color:currentColor;font-weight:700}.live-dot,.dot{width:7px;height:7px;border-radius:50%;background:#1f9d55;display:inline-block}.live-dot{margin-left:auto;box-shadow:0 0 0 3px rgba(31,157,85,.13)}aside em{margin-left:auto;background:#d9403a;color:#fff;border-radius:8px;padding:0 6px;font-size:10px;font-style:normal}.sidefoot{margin-top:auto;display:grid;gap:8px}.mini{padding:11px 12px;border:1px solid rgba(26,35,50,.09);border-radius:11px;background:rgba(255,255,255,.82);font-size:11.5px;color:#5b6778}.mini h3{display:flex;gap:8px;align-items:center;margin:0 0 5px;font-size:12.5px;color:#1a2332}.mini>div{display:flex;justify-content:space-between;margin-top:4px}.mini b{color:#1a2332}.channel.nightly{background:rgba(107,79,191,.12);color:#6b4fbf!important}.update-toast{display:grid;grid-template-columns:auto 1fr;gap:12px;padding:16px;margin-bottom:16px;border:1px solid rgba(107,79,191,.28);border-radius:12px;background:rgba(255,255,255,.94);box-shadow:0 12px 30px -16px rgba(26,35,50,.35)}.update-toast p{margin:5px 0;color:#5b6778}.update-icon{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:rgba(107,79,191,.12);color:#6b4fbf;font-size:20px}.success-toast .update-icon{background:rgba(31,157,85,.13);color:#1f9d55}.toast-actions{grid-column:2;display:flex;justify-content:flex-end;gap:8px}.channel{padding:0 6px;border-radius:999px;background:rgba(58,127,160,.11);color:#2f6a86!important}.healthy{color:#1f9d55!important}.privacy-note{display:flex;gap:8px;align-items:center}.privacy-note span{flex:none}main{min-width:0;min-height:0;overflow-y:auto}.connection{height:42px;background:#1f6b4f;color:#fff;display:flex;align-items:center;gap:10px;padding:0 18px;position:sticky;top:0;z-index:3}.connection .live-dot{margin:0;background:#fff}.connection span{opacity:.85}.connection button{margin-left:auto;background:#fff;color:#9b2929;border:0}.page{padding:24px 30px 70px;max-width:1100px}header{margin-bottom:18px}h1{font-size:22px;line-height:1.2;margin:0;letter-spacing:-.01em}h2{font-size:14px;margin:0}header p,.remote>p{color:#5b6778;margin:4px 0 0}.row{display:flex;justify-content:space-between;align-items:flex-end}.tiles{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}.tiles>a,.card,.form-card,form,.thread,.ticketlist{border:1px solid rgba(26,35,50,.09);border-radius:12px;background:rgba(255,255,255,.86);box-shadow:0 1px 2px rgba(26,35,50,.04),0 10px 30px -12px rgba(26,35,50,.12)}.tiles>a{min-height:145px;padding:16px;display:flex;flex-direction:column;color:inherit;text-decoration:none}.tileicon{width:34px;height:34px;border-radius:9px;background:rgba(58,127,160,.11);color:#2f6a86;display:grid;place-items:center;font-size:19px;margin-bottom:9px}.tileicon.small{width:25px;height:25px;font-size:14px;margin:0}.tiles h2{font-size:14px}.tiles p{margin:5px 0;color:#5b6778}.tiles small{display:flex;align-items:center;gap:7px;margin-top:auto;color:#6a7d94}.off-dot{background:#8a94a3}.warn-dot{background:#d98a0a}.accent-dot{background:#3a7fa0}.good-dot{background:#1f9d55}.card{margin-bottom:16px}.cardhead{min-height:48px;padding:12px 16px;border-bottom:1px solid rgba(26,35,50,.09);display:flex;align-items:center;gap:9px}.cardhead>a,.cardhead>small{margin-left:auto;color:#2f6a86;text-decoration:none}.cardbody{padding:16px}.cardbody>p,.privacy-card p{color:#5b6778;margin:4px 0}.alert,.notice{display:flex;align-items:flex-start;gap:11px;padding:11px 14px;border:1px solid rgba(58,127,160,.34);background:rgba(58,127,160,.11);border-radius:10px;margin-bottom:16px;color:#5b6778}.alert.warn{border-color:rgba(217,138,10,.35);background:rgba(217,138,10,.12)}.alert p{margin:2px 0}.alert .push{margin-left:auto}.notice button{margin-left:auto;border:0;background:transparent}.info{width:17px;height:17px;border-radius:50%;display:grid;place-items:center;background:#3a7fa0;color:#fff;font-weight:700}.button,button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 11px;border-radius:8px;border:1px solid rgba(26,35,50,.14);background:#fff;color:#1a2332;font:inherit;text-decoration:none;cursor:pointer}.primary{background:#3a7fa0!important;border-color:#3a7fa0!important;color:#fff!important}.danger{color:#b91c1c;border-color:rgba(185,28,28,.28)}button:disabled{opacity:.45;cursor:default}.sources{display:grid;grid-template-columns:1fr 1fr;gap:10px}.source{display:flex;align-items:center;gap:10px;border:1px solid rgba(26,35,50,.09);border-radius:10px;padding:11px}.sourceicon{width:32px;height:32px;border-radius:8px;background:rgba(58,127,160,.11);color:#2f6a86;display:grid;place-items:center;font-size:10px;font-weight:700}.source>div{display:grid}.source small{color:#6a7d94}.toggle{width:34px;height:20px;border:0;border-radius:999px;padding:0;background:rgba(26,35,50,.14);position:relative;margin-left:auto;flex:none}.toggle i{position:absolute;width:16px;height:16px;left:2px;top:2px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25)}.toggle.on{background:#3a7fa0}.toggle.on i{left:16px}.terminal{margin-top:14px;padding:14px;height:330px;overflow:auto;white-space:pre-wrap;background:#0b111c;color:#c9d4e3;border-radius:10px;font:11.5px/1.6 ui-monospace,monospace}.terminal b{color:#70b5d3}.form-card{max-width:800px}.form-card label,form label{display:block;font-weight:600;margin:14px 0 6px}.chips{display:flex;gap:7px}.chips button{border-radius:999px;color:#5b6778}.chips button.on{border-color:#3a7fa0;background:rgba(58,127,160,.11);color:#2f6a86;font-weight:600}textarea,input{width:100%;border:1px solid rgba(26,35,50,.14);border-radius:9px;background:#fff;padding:9px 11px;font:inherit;outline:0}textarea:focus,input:focus{border-color:#3a7fa0;box-shadow:0 0 0 3px rgba(58,127,160,.11)}textarea{min-height:115px;resize:vertical}.drop{width:100%;min-height:76px;border:1.5px dashed rgba(26,35,50,.18);display:flex;flex-direction:column;background:#fff;color:#6a7d94}.drop b{font-size:18px}.drop strong{color:#2f6a86}.drop.over{border-color:#3a7fa0;background:rgba(58,127,160,.07)}.drop>*{pointer-events:none}.files{display:grid;gap:6px;margin-top:10px}.files>div{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid rgba(26,35,50,.09);border-radius:9px}.files>div>div{display:grid}.files button{margin-left:auto;border:0}.fileicon{width:30px;height:30px;border-radius:7px;background:rgba(107,79,191,.12);color:#6b4fbf;display:grid;place-items:center;font-size:9px;font-weight:700}.actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:16px}.actions>small{margin-right:auto}.actions.center{justify-content:center}.actions.center>small{margin:0}small{color:#6a7d94}.ticketgrid{display:grid;grid-template-columns:280px minmax(0,1fr);gap:16px;align-items:start}.ticketlist{padding:8px;display:grid;gap:4px}.ticketlist button{border:0;text-align:left;display:grid;gap:3px;position:relative}.ticketlist button.on{background:rgba(58,127,160,.11);color:#2f6a86}.ticketlist button span{position:absolute;right:8px;top:8px;font-size:10px;border-radius:999px;padding:1px 6px;background:rgba(58,127,160,.11)}.empty{padding:36px 15px;text-align:center;color:#6a7d94}form{padding:20px}.thread{overflow:hidden}.threadhead{display:flex;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(26,35,50,.09)}.pill{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(58,127,160,.11);color:#2f6a86;height:max-content}.message{display:flex;gap:10px;margin:16px}.message>div{flex:1;border:1px solid rgba(26,35,50,.09);border-radius:11px;padding:12px 14px}.message.staff>div{background:rgba(58,127,160,.07)}.message p{white-space:pre-wrap;margin:6px 0}.avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:#3a7fa0;color:#fff;font-size:10px;font-weight:700;flex:none}.avatar.you{background:#6b4fbf}.attachment{font-size:12px;color:#5b6778}.composer{margin:16px;border:1px solid rgba(26,35,50,.14);border-radius:10px;overflow:hidden}.composer textarea{border:0;box-shadow:none;min-height:72px}.composer>div{padding:8px 10px;border-top:1px solid rgba(26,35,50,.09);display:flex;justify-content:space-between}.approval{display:flex;align-items:center;gap:12px;padding:16px}.approval p{margin:2px 0;color:#6a7d94}.approver{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;background:#3a7fa0;color:#fff;font-weight:700}.remote{text-align:center;max-width:790px;margin:0 auto}.remote.waiting{max-width:600px;padding-top:45px}.status{margin:0 auto 16px;width:54px;height:54px;border-radius:50%;display:grid;place-items:center;background:rgba(58,127,160,.11);color:#2f6a86;font-size:22px}.remote.connected .status,.remote.ended .status{background:rgba(31,157,85,.13);color:#1f9d55}.scope{display:grid;grid-template-columns:1fr 1fr;gap:12px;text-align:left;margin-top:20px}.scope>div{padding:13px 16px;border:1px solid rgba(26,35,50,.09);border-radius:10px;background:rgba(255,255,255,.86)}.scope h3{margin:0;font-size:13px}.scope .can{color:#1f9d55}.scope .cant{color:#b91c1c}.scope ul{padding-left:18px;color:#5b6778;line-height:1.8}.spinner{width:27px;height:27px;border:3px solid rgba(58,127,160,.2);border-top-color:#3a7fa0;border-radius:50%;animation:spin 1s linear infinite}.request{margin:20px auto 0;text-align:left;padding:16px}.request>div{display:grid;grid-template-columns:100px 1fr;margin:5px}.request span{color:#6a7d94}.queue{color:#2f6a86;display:flex;align-items:center;gap:7px}.settings>div{padding:17px;display:flex;gap:14px;border-bottom:1px solid rgba(26,35,50,.09)}.request-form{padding:16px;margin-top:18px;text-align:left}.request-form label{display:block;font-weight:600;margin-bottom:6px}.activity{margin-top:20px;text-align:left}.activity details{border-top:1px solid rgba(26,35,50,.09)}.activity summary{display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer}.activity summary span:nth-child(2){display:grid;flex:1}.activity summary span:last-child{color:#2f6a86}.activity pre{margin:0 16px 14px;padding:12px;overflow:auto;border-radius:8px;background:#0b111c;color:#c9d4e3;font:11px/1.5 ui-monospace,monospace}.settings>div:last-child{border:0}.settings span{display:grid;flex:1}.settings small{margin-top:3px}.settings .toggle{align-self:center}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:900px){.shell{grid-template-columns:190px minmax(0,1fr)}.page{padding:22px}.ticketgrid{grid-template-columns:1fr}.sources{grid-template-columns:1fr}}
</style>
