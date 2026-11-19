<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useConvStore } from '../useConvStore';
import type { ListSegment, PersonView, ThreadView } from '../ConversationScreenStore';
import ConvAvatar from './ConvAvatar.vue';
import ConvIcon from './ConvIcon.vue';

const store = useConvStore();
const searchInput = ref<HTMLInputElement | null>(null);
const picking = ref(false);
const picked = ref<string[]>([]);

const titles: Record<string, string> = { threads: 'Conversations', people: 'People', agents: 'Agent threads' };
const title = computed(() => titles[store.s.listTab] ?? 'Conversations');
const segments: { id: ListSegment; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'people', label: 'People' },
  { id: 'agents', label: 'Agents' },
  { id: 'unread', label: 'Unread' },
];
const query = computed({ get: () => store.s.query, set: (value: string) => store.setQuery(value) });
const rows = computed<ThreadView[]>(() => store.visibleThreads());
const people = computed(() => store.visiblePeople());
const me = computed(() => store.visibleMe());

/** The mockup's ⌘K hint: Cmd+K (Ctrl+K off macOS) focuses the search box. */
function focusSearch(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchInput.value?.focus();
  }
}
onMounted(() => window.addEventListener('keydown', focusSearch));
onBeforeUnmount(() => window.removeEventListener('keydown', focusSearch));

/** The person row is highlighted while their direct conversation is open, as in the mockup. */
const activeDirectId = computed(() => {
  const open = store.thread(store.s.thread);
  return open?.kind === 'direct' ? open.withId : '';
});

/** Mockup threadAvatar(): the other person's avatar for a direct message, a lettered tile for a group. */
function withPerson(thread: ThreadView): PersonView | undefined { return store.personFor(thread.withId); }
function groupLetter(thread: ThreadView): string { return thread.title.trim()[0]?.toUpperCase() ?? '?'; }
function isUnread(thread: ThreadView): boolean { return store.isUnread(thread); }
function presOf(person: PersonView | undefined): string { return person ? person.presenceClass : ''; }
function toggle(personId: string): void {
  picked.value = picked.value.includes(personId) ? picked.value.filter(id => id !== personId) : [...picked.value, personId];
}
// Leaving People ends pick mode, so the next visit starts on the normal list.
watch(() => store.s.listTab, tab => { if (tab !== 'people') { picking.value = false; picked.value = []; } });
/** New: pick people for a conversation. From the thread lists it opens People in pick mode. */
function startNew(): void {
  if (store.s.listTab !== 'people') { store.setListTab('people'); picking.value = true; return; }
  picking.value = !picking.value;
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
      <h2>{{ title }}<button class="btn sm" :disabled="!store.people().length" @click="startNew"><ConvIcon :name="picking && store.s.listTab === 'people' ? 'x' : 'plus'" />{{ picking && store.s.listTab === 'people' ? 'Cancel' : 'New' }}</button></h2>
      <label class="search"><ConvIcon name="search" /><input ref="searchInput" v-model="query" :placeholder="`Search ${store.org().name || 'conversations'}`" /><kbd>&#8984;K</kbd></label>
      <div v-if="store.s.listTab === 'threads'" class="seg" role="tablist" aria-label="Filter conversations"><button v-for="segment in segments" :key="segment.id" role="tab" :aria-selected="store.s.segment === segment.id" :class="{ on: store.s.segment === segment.id }" @click="store.setSegment(segment.id)">{{ segment.label }}</button></div>
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
        <div v-else-if="store.people().length" class="list-empty"><b>Nothing here</b></div>
        <div v-else class="list-empty"><b>No people yet</b>Members of this organization show up here once they join.</div>
        <div v-for="person in people" :key="person.id" class="row" :class="{ on: picking ? picked.includes(person.id) : activeDirectId === person.id }" @click="picking ? toggle(person.id) : undefined">
          <input v-if="picking" type="checkbox" class="pick" :checked="picked.includes(person.id)" :aria-label="`Add ${person.name} to the group`" @click.stop="toggle(person.id)" />
          <ConvAvatar :ini="person.initials" :color="person.tone" :pres="person.presenceClass" size="lg" />
          <div class="tx">
            <div class="t1"><b>{{ person.name }}</b><span v-if="person.role" class="pill idle">{{ person.role }}</span></div>
            <div class="t2">{{ person.status }}</div>
            <div v-if="person.hasAgent" class="person-agent"><ConvAvatar bot theirs :pres="person.agentOnline ? 'online' : 'offline'" /> {{ person.agentName }} <span style="color:var(--dim)">· {{ person.agentOnline ? 'online' : 'offline' }}</span></div>
          </div>
          <div v-if="!picking" class="acts">
            <button class="btn sm ghost" title="Message" @click.stop="store.openDirect(person.id)"><ConvIcon name="chat" /></button>
            <button class="btn sm ghost" title="Voice call" disabled @click.stop><ConvIcon name="phone" /></button>
            <button class="btn sm ghost" title="Video call" disabled @click.stop><ConvIcon name="video" /></button>
          </div>
        </div>
        <template v-if="!picking && store.invited().length">
          <div class="lgrp">Invited · {{ store.invited().length }}</div>
          <div v-for="invite in store.invited()" :key="invite.id" class="row">
            <ConvAvatar :ini="invite.initials" size="lg" />
            <div class="tx">
              <div class="t1"><b>{{ invite.email }}</b><span class="pill warn">Invited</span></div>
              <div class="t2">Invitation pending</div>
            </div>
          </div>
        </template>
        <div v-if="picking" class="list-empty" style="display:grid;gap:8px">
          <span>{{ picked.length }} selected. A group needs at least two people.</span>
          <button class="btn sm pri" :disabled="picked.length < 2" @click="createGroup"><ConvIcon name="chat" />Start group conversation</button>
        </div>
      </template>
      <template v-else>
        <div v-if="!rows.length && (store.s.query.trim() || (store.s.listTab === 'threads' && store.s.segment !== 'all'))" class="list-empty"><b>Nothing here</b></div>
        <div v-else-if="!rows.length" class="list-empty"><b>{{ store.s.listTab === 'agents' ? 'No agent threads yet' : 'No conversations yet' }}</b>Conversations in this organization show up here.</div>
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
