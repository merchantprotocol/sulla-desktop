<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useConvStore } from '../useConvStore';
import type { PersonView, ThreadView } from '../ConversationScreenStore';
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
const me = computed(() => (store.me() && (!term.value || store.me()!.name.toLowerCase().includes(term.value)) ? store.me() : null));

/** The person row is highlighted while their direct conversation is open, as in the mockup. */
const activeDirectId = computed(() => {
  const open = store.thread(store.s.thread);
  return open?.kind === 'direct' ? open.withId : '';
});

/** Mockup threadAvatar(): the other person's avatar for a direct message, a lettered tile for a group. */
function withPerson(thread: ThreadView): PersonView | undefined { return store.personFor(thread.withId); }
function groupLetter(thread: ThreadView): string { return thread.title.trim()[0]?.toUpperCase() ?? '?'; }
function isUnread(thread: ThreadView): boolean { return thread.unread > 0 && store.s.thread !== thread.id; }
function presOf(person: PersonView | undefined): string { return person ? person.presenceClass : ''; }
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
      <h2>{{ title }}<button v-if="store.s.listTab === 'people'" class="btn sm" :disabled="!store.people().length" @click="picking = !picking"><ConvIcon :name="picking ? 'x' : 'plus'" />{{ picking ? 'Cancel' : 'New' }}</button></h2>
      <label class="search"><ConvIcon name="search" /><input v-model="query" :placeholder="`Search ${store.org().name || 'conversations'}`" /></label>
    </div>
    <div class="list-body">
      <template v-if="store.s.listTab === 'people'">
        <template v-if="!picking && store.requests().length">
          <div class="lgrp">Contact requests · {{ store.requests().length }}</div>
          <div v-for="request in store.requests()" :key="request.senderId" class="row">
            <ConvAvatar :ini="request.initials" size="lg" />
            <div class="tx">
              <div class="t1"><b>{{ request.name }}</b><span class="pill warn">{{ request.count }} request{{ request.count === 1 ? '' : 's' }}</span><time>{{ request.time }}</time></div>
              <div class="t2">{{ request.latest }}</div>
            </div>
            <div class="acts"><button class="btn sm" disabled title="Coming soon">Allow</button><button class="btn sm ghost" disabled title="Coming soon">Not now</button></div>
          </div>
        </template>
        <template v-if="me && !picking">
          <div class="lgrp">You</div>
          <div class="row">
            <ConvAvatar :ini="me.initials" color="a" :pres="me.presenceClass" size="lg" />
            <div class="tx">
              <div class="t1"><b>{{ me.name }}</b><span v-if="me.role" class="pill acc">{{ me.role }}</span></div>
              <div class="t2">{{ me.status }}</div>
              <div class="person-agent"><ConvAvatar bot :pres="me.agentOnline ? 'online' : 'offline'" /> Your agent <span style="color:var(--dim)">· {{ me.agentOnline ? 'online' : 'offline' }}</span></div>
            </div>
          </div>
        </template>
        <div v-if="people.length" class="lgrp">Members · {{ people.length }}</div>
        <div v-else class="list-empty"><b>No people yet</b>Members of this organization show up here once they join.</div>
        <div v-for="person in people" :key="person.id" class="row" :class="{ on: picking ? picked.includes(person.id) : activeDirectId === person.id }" @click="picking ? toggle(person.id) : undefined">
          <input v-if="picking" type="checkbox" class="pick" :checked="picked.includes(person.id)" :aria-label="`Add ${person.name} to the group`" @click.stop="toggle(person.id)" />
          <ConvAvatar :ini="person.initials" :color="person.tone" :pres="person.presenceClass" size="lg" />
          <div class="tx">
            <div class="t1"><b>{{ person.name }}</b><span v-if="person.role" class="pill idle">{{ person.role }}</span></div>
            <div class="t2">{{ person.status }}</div>
            <div class="person-agent"><ConvAvatar bot theirs :pres="person.agentOnline ? 'online' : 'offline'" /> {{ person.firstName }}'s agent <span style="color:var(--dim)">· {{ person.agentOnline ? 'online' : 'offline' }}</span></div>
          </div>
          <div v-if="!picking" class="acts">
            <button class="btn sm ghost" title="Message" @click.stop="store.openDirect(person.id)"><ConvIcon name="chat" /></button>
            <button class="btn sm ghost" title="Voice call" disabled @click.stop><ConvIcon name="phone" /></button>
            <button class="btn sm ghost" title="Video call" disabled @click.stop><ConvIcon name="video" /></button>
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
          <span v-if="thread.kind === 'agent_thread'" style="position:relative;display:inline-flex;width:34px;height:34px"><ConvAvatar bot size="sm" /><span style="position:absolute;right:0;bottom:0"><ConvAvatar bot theirs size="sm" :pres="withPerson(thread)?.agentOnline ? 'online' : 'offline'" /></span></span>
          <span v-else-if="thread.kind === 'group'" class="avatar lg bot" style="background:linear-gradient(135deg,#9ec1d3,#3a7fa0);border-radius:10px;font-size:12px">{{ groupLetter(thread) }}</span>
          <ConvAvatar v-else :ini="withPerson(thread)?.initials ?? '?'" :color="withPerson(thread)?.tone ?? ''" :pres="presOf(withPerson(thread))" size="lg" />
          <div class="tx">
            <div class="t1"><b>{{ thread.title }}</b><span v-if="thread.kind === 'agent_thread'" class="pill agent">Agents</span><time>{{ thread.time }}</time></div>
            <div class="t2" :class="{ unread: isUnread(thread) }">{{ thread.latest }}</div>
          </div>
          <span v-if="isUnread(thread)" class="badge">{{ thread.unread }}</span>
        </div>
      </template>
    </div>
  </section>
</template>
