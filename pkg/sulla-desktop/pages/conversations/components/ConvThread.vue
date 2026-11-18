<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
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
const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
const goOnline = (): void => { online.value = true; };
const goOffline = (): void => { online.value = false; };
onMounted(() => {
  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);
});
onBeforeUnmount(() => {
  window.removeEventListener('online', goOnline);
  window.removeEventListener('offline', goOffline);
});

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
        <template v-if="thread">
          <ConvAvatar :bot="isAgentThread" :ini="isAgentThread ? '' : (thread.title.split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase())" size="lg" />
          <div class="ttl"><b>{{ threadTitle }}</b><small>{{ isAgentThread ? 'Agent thread' : thread.kind === 'group' ? `${memberCount} people` : 'Direct message' }}</small></div>
        </template>
        <div v-else class="ttl"><b>Conversations</b><small>Choose a conversation on the left</small></div>
        <div class="acts">
          <button class="btn sm" disabled title="Coming soon"><ConvIcon name="phone" /></button>
          <button class="btn sm" disabled title="Coming soon"><ConvIcon name="video" />Call</button>
          <button class="btn sm" @click="store.requestSecretary()"><ConvIcon name="mic" />Start Secretary</button>
          <button class="btn sm ghost" title="Details" @click="store.toggleInfo()"><ConvIcon name="info" /></button>
        </div>
      </div>

      <div v-if="!online" class="banner warn"><ConvIcon name="wifi" /><span><b>You're offline.</b> Messages you send will go out when you reconnect.</span></div>
      <div v-if="error" class="banner bad" role="alert"><span>{{ error }}</span></div>

      <div class="msgs">
        <div v-if="thread && !messages.length" class="meta" style="padding:16px;color:var(--muted)">No messages yet. Send the first one below.</div>
        <div v-if="!thread" class="empty"><div class="in"><h1>Pick a conversation</h1><p>Choose a conversation on the left to see its messages.</p></div></div>
        <ConvMessage v-for="message in messages" :key="message.id" :message="message" />
      </div>

      <div v-if="thread && isAgentThread" class="composer"><div class="box" style="opacity:.75"><div class="cr"><span class="hint">Agent threads are read-only here. Agents post in them, not people.</span></div></div></div>
      <div v-else-if="thread" class="composer">
        <div class="box">
          <div class="as orgline"><span class="ochip xs">{{ store.org().initials }}</span>Posting in <b>{{ store.org().name }}</b> › {{ threadTitle }}</div>
          <textarea v-model="draft" :placeholder="`Message ${threadTitle}`" @keydown.enter.exact.prevent="sendDraft" />
          <div class="cr">
            <button class="btn sm ghost" disabled title="Coming soon"><ConvIcon name="video" />Video</button>
            <span class="sp" />
            <span class="hint">Enter to send</span>
            <button class="btn sm pri" :disabled="!draft.trim()" @click="sendDraft"><ConvIcon name="send" />Send</button>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
