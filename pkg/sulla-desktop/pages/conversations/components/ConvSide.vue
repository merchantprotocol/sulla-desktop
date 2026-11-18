<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { PersonView } from '../ConversationScreenStore';
import { useConvStore } from '../useConvStore';
import ConvAvatar from './ConvAvatar.vue';
import ConvIcon from './ConvIcon.vue';

const store = useConvStore();
const thread = computed(() => store.thread(store.s.thread));
const sideClass = computed(() => (store.s.infoOpen && thread.value ? 'side open' : 'side hide'));
const online = computed(() => store.online());
const meId = computed(() => store.me()?.id ?? '');
/** Everyone in the thread except you, from the directory. */
const others = computed(() => (thread.value?.participantIds ?? []).filter(id => id !== meId.value).map(id => store.personFor(id)).filter((person): person is PersonView => !!person));
const inThread = computed(() => !!meId.value && !!thread.value?.participantIds.includes(meId.value));
const person = computed(() => others.value[0]);
/** Mockup person card: "Member · Merchant Protocol". The role part is omitted when the directory sends none. */
const roleLine = computed(() => [person.value?.role, store.org().name].filter(Boolean).join(' · '));
function pres(entry: PersonView): string { return online.value ? entry.presenceClass : 'offline'; }
function agentLine(entry: PersonView): string { return `Acts for ${entry.name} · ${online.value && entry.agentOnline ? 'online' : 'offline'}`; }
</script>

<template>
  <aside :class="sideClass">
    <button class="btn sm ghost side-x" @click="store.toggleInfo()">Close</button>
    <template v-if="thread?.kind === 'agent_thread'">
      <h3>Who is talking</h3>
      <div class="card">
        <div class="agent-id"><ConvAvatar bot size="lg" :pres="online ? 'online' : 'offline'" /><div><b>Your agent</b><small>Acts for you{{ store.me() ? `, ${store.me()!.firstName}` : '' }}</small></div></div>
      </div>
      <div v-if="person" class="card">
        <div class="agent-id"><ConvAvatar bot theirs size="lg" :pres="online && person.agentOnline ? 'online' : 'offline'" /><div><b>{{ person.firstName }}'s agent</b><small>{{ agentLine(person) }}</small></div></div>
      </div>
      <div class="meta"><ConvIcon name="info" /> Each agent acts within its own human's permissions, never the other's.</div>
      <h3>Controls</h3>
      <div class="card" style="display:grid;gap:6px">
        <button class="btn sm danger" disabled title="Coming soon"><ConvIcon name="stop" />Stop thread</button>
        <button class="btn sm" disabled title="Coming soon"><ConvIcon name="hand" />Take over</button>
      </div>
    </template>
    <template v-else-if="thread?.kind === 'group'">
      <h3>Members · {{ thread.participantIds.length }}</h3>
      <div class="card">
        <div v-for="member in others" :key="member.id" class="memb"><ConvAvatar :ini="member.initials" :color="member.tone" :pres="pres(member)" size="sm" />{{ member.name }}<small>{{ online ? member.status : '' }}</small></div>
        <div v-if="inThread && store.me()" class="memb"><ConvAvatar :ini="store.me()!.initials" color="a" size="sm" />You<small>{{ store.me()!.role }}</small></div>
      </div>
    </template>
    <template v-else-if="thread && person">
      <h3>Person</h3>
      <div class="card">
        <div class="agent-id"><ConvAvatar :ini="person.initials" :color="person.tone" size="lg" :pres="pres(person)" /><div><b>{{ person.name }}</b><small>{{ roleLine }}</small><small>{{ online ? person.status : 'Presence unknown' }}</small></div></div>
        <div style="display:flex;gap:6px;margin-top:10px">
          <button class="btn sm" @click="store.openDirect(person.id)"><ConvIcon name="chat" />Message</button>
          <button class="btn sm" disabled title="Voice call · coming soon"><ConvIcon name="phone" /></button>
          <button class="btn sm" disabled title="Video call · coming soon"><ConvIcon name="video" />Call</button>
          <button class="btn sm" @click="store.requestSecretary()"><ConvIcon name="mic" />Secretary</button>
        </div>
      </div>
      <template v-if="person.hasAgent">
        <h3>{{ person.firstName }}'s agent</h3>
        <div class="card">
          <div class="agent-id"><ConvAvatar bot theirs size="lg" :pres="online && person.agentOnline ? 'online' : 'offline'" /><div><b>{{ person.agentName || `${person.firstName}'s agent` }}</b><small>{{ agentLine(person) }}</small></div></div>
        </div>
      </template>
    </template>
  </aside>
</template>
