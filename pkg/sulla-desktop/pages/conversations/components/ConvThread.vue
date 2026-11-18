<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useConvStore } from '../useConvStore';
import ConvAvatar from './ConvAvatar.vue';
import ConvIcon from './ConvIcon.vue';
import ConvMessage from './ConvMessage.vue';

defineProps<{ error: string }>();
const store = useConvStore();
const draft = ref('');

const thread = computed(() => store.thread(store.s.thread));
const messages = computed(() => store.bodyFor(store.s.thread));
const hasOrg = computed(() => !!store.s.org);
const threadTitle = computed(() => thread.value?.title ?? '');
const memberCount = computed(() => (thread.value?.participantIds.length ?? 0));
const isAgentThread = computed(() => thread.value?.kind === 'agent_thread');
const other = computed(() => (thread.value?.withId ? store.personFor(thread.value.withId) : undefined));
const online = computed(() => store.online());
/** Group header avatar stack: the other members, without presence dots, as in the mockup. */
const stack = computed(() => (thread.value?.participantIds ?? []).filter(id => id !== store.me()?.id).map(id => store.personFor(id)).filter((person): person is NonNullable<typeof person> => !!person));
/** Mockup composer placeholder: the first name in a direct message, the thread title otherwise. */
const placeholder = computed(() => `Message ${thread.value?.kind === 'direct' && other.value ? other.value.firstName : threadTitle.value}`);
/** The direct-message header subtitle, from the directory presence. */
const dmSubtitle = computed(() => (!online.value ? 'Presence unknown while offline' : other.value?.status ?? 'Direct message'));
/** Info banner when the other person in a direct message is offline. */
const personOffline = computed(() => online.value && thread.value?.kind === 'direct' && other.value?.presenceClass === 'offline');

function sendDraft(): void {
  const text = draft.value.trim();
  if (!text) return;
  store.send(text);
  draft.value = '';
}
</script>

<template>
  <section class="main">
    <template v-if="!hasOrg || (!store.threads().length && !store.s.thread)">
      <div class="top"><div class="ttl"><b>{{ store.org().name || 'Conversations' }}</b><small>{{ hasOrg ? 'No conversations yet' : 'No organization yet' }}</small></div></div>
      <div class="empty">
        <div class="in">
          <div class="ic"><ConvIcon name="people" /></div>
          <h1>Start your first conversation</h1>
          <p>Invite your team to talk with them here. Once they join, your agent can also talk to their agents, and you'll see every one of those threads.</p>
          <div class="r">
            <button class="btn pri" disabled title="Coming soon"><ConvIcon name="invite" />Invite people</button>
            <button class="btn" @click="store.requestSecretary()"><ConvIcon name="mic" />Start Secretary Mode</button>
          </div>
          <p style="margin-top:14px;font-size:11.5px;color:var(--dim)">Secretary Mode works without anyone else. Notes go to your Files.</p>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="top">
        <template v-if="thread && isAgentThread">
          <span style="display:flex;align-items:center;gap:4px"><ConvAvatar bot size="lg" :pres="online ? 'online' : 'offline'" /><span style="color:var(--dim)">&harr;</span><ConvAvatar bot theirs size="lg" :pres="online && other?.agentOnline ? 'online' : 'offline'" /></span>
          <div class="ttl"><b v-if="other"><span class="who you" style="font-size:12px">Your agent</span> and <span class="who theirs" style="font-size:12px">{{ other.firstName }}'s agent</span></b><b v-else>{{ threadTitle }}</b><small>Agent thread{{ other ? ` · you and ${other.name} can watch it` : '' }}</small></div>
          <div class="acts">
            <button class="btn sm danger" disabled title="Coming soon"><ConvIcon name="stop" />Stop</button>
            <button class="btn sm" disabled title="Coming soon"><ConvIcon name="hand" />Take over</button>
            <button v-if="other" class="btn sm" @click="store.openDirect(other.id)"><ConvIcon name="chat" />Message {{ other.firstName }}</button>
            <button class="btn sm ghost" title="Who is talking" @click="store.toggleInfo()"><ConvIcon name="info" /></button>
          </div>
        </template>
        <template v-else-if="thread && thread.kind === 'group'">
          <span class="avatar lg bot" style="background:linear-gradient(135deg,#9ec1d3,#3a7fa0);border-radius:10px;font-size:12px">{{ threadTitle.trim()[0]?.toUpperCase() ?? '?' }}</span>
          <div class="ttl"><b>{{ threadTitle }}</b><small>{{ memberCount }} people</small></div>
          <div class="acts">
            <span v-if="stack.length" class="stack"><ConvAvatar v-for="person in stack" :key="person.id" :ini="person.initials" :color="person.tone" size="sm" /></span>
            <button class="btn sm" disabled title="Voice call · coming soon"><ConvIcon name="phone" /></button>
            <button class="btn sm" disabled title="Video call · coming soon"><ConvIcon name="video" />Call</button>
            <button class="btn sm pri" @click="store.requestSecretary()"><ConvIcon name="mic" />Start Secretary</button>
            <button class="btn sm ghost" title="Details" @click="store.toggleInfo()"><ConvIcon name="info" /></button>
          </div>
        </template>
        <template v-else-if="thread">
          <ConvAvatar :ini="other?.initials ?? '?'" :color="other?.tone ?? ''" :pres="online ? other?.presenceClass ?? '' : 'offline'" size="lg" />
          <div class="ttl"><b>{{ threadTitle }}</b><small>{{ dmSubtitle }}</small></div>
          <div class="acts">
            <button class="btn sm" disabled title="Voice call · coming soon"><ConvIcon name="phone" /></button>
            <button class="btn sm" disabled title="Video call · coming soon"><ConvIcon name="video" />Call</button>
            <button class="btn sm" @click="store.requestSecretary()"><ConvIcon name="mic" />Start Secretary</button>
            <button class="btn sm ghost" title="Details" @click="store.toggleInfo()"><ConvIcon name="info" /></button>
          </div>
        </template>
        <template v-else>
          <div class="ttl"><b>Conversations</b><small>Choose a conversation on the left</small></div>
        </template>
      </div>

      <div v-if="!online && isAgentThread" class="banner warn"><ConvIcon name="wifi" /><span><b>You're offline.</b> Your agent paused this thread. {{ other ? `${other.firstName}'s agent` : 'The other agent' }} can't reach yours until you reconnect.</span></div>
      <div v-else-if="!online" class="banner warn"><ConvIcon name="wifi" /><span><b>You're offline.</b> Messages you send will go out when you reconnect.</span></div>
      <div v-else-if="personOffline && other" class="banner warn"><ConvIcon name="info" /><span>{{ other.firstName }} is offline{{ other.hasAgent && !other.agentOnline ? ` and ${other.firstName}'s agent is offline too` : '' }}. Messages will be delivered when {{ other.firstName }} is back.</span></div>
      <div v-if="error" class="banner bad" role="alert"><span>{{ error }}</span></div>

      <div class="msgs">
        <div v-if="thread && !messages.length" class="meta" style="padding:16px;color:var(--muted)">No messages yet. Send the first one below.</div>
        <div v-if="!thread" class="empty"><div class="in"><h1>Pick a conversation</h1><p>Choose a conversation on the left to see its messages.</p></div></div>
        <template v-for="(message, index) in messages" :key="message.id">
          <div v-if="message.day && message.day !== messages[index - 1]?.day" class="day">{{ message.day }}</div>
          <ConvMessage :message="message" />
        </template>
      </div>

      <div v-if="thread && isAgentThread" class="composer"><div class="box" style="opacity:.75"><div class="cr"><span class="hint">{{ online ? 'Agent threads are read-only here. Agents post in them, not people.' : 'Paused while offline.' }}</span></div></div></div>
      <div v-else-if="thread" class="composer">
        <div class="box">
          <div class="as orgline"><span class="ochip xs" :style="{ background: store.org().gradient }">{{ store.org().initials }}</span>Posting in <b>{{ store.org().name }}</b> &rsaquo; {{ threadTitle }}</div>
          <textarea v-model="draft" :placeholder="placeholder" @keydown.enter.exact.prevent="sendDraft" />
          <div class="cr">
            <button class="btn sm ghost" disabled title="Attach from Files · coming soon"><ConvIcon name="clip" /></button>
            <button class="btn sm ghost" disabled title="Record a video message · coming soon"><ConvIcon name="video" />Video</button>
            <button class="btn sm ghost" disabled title="Coming soon">@ Your agent</button>
            <span class="sp" />
            <span v-if="!online" class="hint" style="color:var(--warn)">Offline · will send when you reconnect</span>
            <span v-else class="hint">Enter to send</span>
            <button class="btn sm pri" @click="sendDraft"><ConvIcon name="send" />Send</button>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
