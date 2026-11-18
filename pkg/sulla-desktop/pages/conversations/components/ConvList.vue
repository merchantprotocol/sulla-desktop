<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useConvStore } from '../useConvStore';
import type { ThreadView } from '../ConversationScreenStore';
import ConvAvatar from './ConvAvatar.vue';
import ConvIcon from './ConvIcon.vue';

const store = useConvStore();
const query = ref('');
const picking = ref(false);
const picked = ref<string[]>([]);

const titles: Record<string, string> = { threads: 'Conversations', people: 'People', agents: 'Agent threads' };
const title = computed(() => titles[store.s.listTab] ?? 'Conversations');
const term = computed(() => query.value.trim().toLowerCase());
const rows = computed<ThreadView[]>(() => store.threadsForTab().filter(thread => !term.value || thread.title.toLowerCase().includes(term.value)));
const people = computed(() => store.people().filter(person => !term.value || person.name.toLowerCase().includes(term.value)));

function initialsOf(label: string): string { return label.split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase() || '?'; }
function kindLabel(thread: ThreadView): string {
  if (thread.kind === 'agent_thread') return 'Agent thread';
  if (thread.kind === 'group') return `Group · ${thread.participantIds.length} people`;
  return 'Direct message';
}
function presenceClass(presence: string): string { return presence.toLowerCase() === 'online' ? 'online' : 'offline'; }
function toggle(personId: string): void {
  picked.value = picked.value.includes(personId) ? picked.value.filter(id => id !== personId) : [...picked.value, personId];
}
function createGroup(): void {
  store.createGroup(picked.value);
  picked.value = [];
  picking.value = false;
}
</script>

<template>
  <section class="list">
    <div class="list-top">
      <h2>{{ title }}<button v-if="store.s.listTab === 'people'" class="btn sm" :disabled="!store.people().length" @click="picking = !picking"><ConvIcon name="plus" />{{ picking ? 'Cancel' : 'New group' }}</button></h2>
      <label class="search"><ConvIcon name="search" /><input v-model="query" :placeholder="`Search ${store.org().name || 'conversations'}`" /></label>
    </div>
    <div class="list-body">
      <template v-if="store.s.listTab === 'people'">
        <template v-if="!picking && store.requests().length">
          <div class="lgrp">Contact requests · {{ store.requests().length }}</div>
          <div v-for="request in store.requests()" :key="request.senderId" class="row">
            <ConvAvatar :ini="request.initials" size="lg" />
            <div class="tx">
              <div class="t1"><b>{{ request.name }}</b><time>{{ request.time }}</time></div>
              <div class="t2">{{ request.latest }}</div>
              <small class="person-agent">{{ request.count }} request{{ request.count === 1 ? '' : 's' }} · waiting for your answer</small>
            </div>
            <div class="acts"><button class="btn sm" disabled title="Coming soon">Allow</button><button class="btn sm ghost" disabled title="Coming soon">Not now</button></div>
          </div>
        </template>
        <div v-if="!people.length" class="list-empty"><b>No people yet</b>Members of this organization show up here once they join.</div>
        <div v-for="person in people" :key="person.id" class="row" :class="{ on: picking && picked.includes(person.id) }" @click="picking ? toggle(person.id) : undefined">
          <input v-if="picking" type="checkbox" :checked="picked.includes(person.id)" :aria-label="`Add ${person.name} to the group`" @click.stop="toggle(person.id)" />
          <ConvAvatar :ini="person.initials" :pres="presenceClass(person.presence)" size="lg" />
          <div class="tx">
            <div class="t1"><b>{{ person.name }}</b></div>
            <div class="t2">{{ person.presence || 'Not online' }}</div>
            <div class="person-agent"><ConvAvatar bot size="sm" :pres="person.agentOnline ? 'online' : 'offline'" />{{ person.agentOnline ? 'Agent online' : 'Agent offline' }}</div>
          </div>
          <div v-if="!picking" class="acts">
            <button class="btn sm ghost" title="Message" @click.stop="store.openDirect(person.id)"><ConvIcon name="chat" /></button>
            <button class="btn sm ghost" title="Voice call" disabled><ConvIcon name="phone" /></button>
          </div>
        </div>
        <div v-if="picking" class="list-empty" style="display:grid;gap:8px">
          <span>{{ picked.length }} selected. A group needs at least two people.</span>
          <button class="btn sm pri" :disabled="picked.length < 2" @click="createGroup"><ConvIcon name="chat" />Start group conversation</button>
        </div>
      </template>
      <template v-else>
        <div v-if="!rows.length" class="list-empty"><b>{{ store.s.listTab === 'agents' ? 'No agent threads yet' : 'No conversations yet' }}</b>Conversations in this organization show up here.</div>
        <div v-for="thread in rows" :key="thread.id" class="row" :class="{ on: store.s.thread === thread.id }" @click="store.openThread(thread.id)">
          <ConvAvatar :bot="thread.kind === 'agent_thread'" :ini="thread.kind === 'agent_thread' ? '' : initialsOf(thread.title)" size="lg" />
          <div class="tx">
            <div class="t1"><b>{{ thread.title }}</b><time>{{ thread.time }}</time></div>
            <div class="t2">{{ thread.latest }}</div>
            <small class="person-agent">{{ kindLabel(thread) }}</small>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>
