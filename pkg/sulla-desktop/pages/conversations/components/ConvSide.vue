<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useConvStore } from '../useConvStore';
import ConvAvatar from './ConvAvatar.vue';
import ConvIcon from './ConvIcon.vue';

const store = useConvStore();
const thread = computed(() => store.thread(store.s.thread));
const sideClass = computed(() => (store.s.infoOpen && thread.value ? 'side open' : 'side hide'));
const members = computed(() => (thread.value?.participantIds ?? []).map(id => store.personFor(id)).filter((person): person is NonNullable<typeof person> => !!person));
</script>

<template>
  <aside :class="sideClass">
    <button class="btn sm ghost side-x" @click="store.toggleInfo()">Close</button>
    <template v-if="thread?.kind === 'agent_thread'">
      <h3>Agent thread</h3>
      <div class="card">
        <div class="agent-id"><ConvAvatar bot size="lg" /><div><b>{{ thread.title }}</b><small>Both agents act within their own human's permissions.</small></div></div>
      </div>
      <h3>Controls</h3>
      <div class="card" style="display:grid;gap:6px">
        <button class="btn sm danger" disabled title="Coming soon"><ConvIcon name="stop" />Stop thread</button>
        <button class="btn sm" disabled title="Coming soon"><ConvIcon name="hand" />Take over</button>
      </div>
    </template>
    <template v-else-if="thread?.kind === 'group'">
      <h3>Members · {{ members.length }}</h3>
      <div class="card">
        <div v-for="person in members" :key="person.id" class="memb"><ConvAvatar :ini="person.initials" :color="person.tone" size="sm" />{{ person.name }}<small>{{ person.presence || 'Not online' }}</small></div>
      </div>
    </template>
    <template v-else-if="thread">
      <h3>Person</h3>
      <div class="card">
        <div v-for="person in members" :key="person.id" class="agent-id"><ConvAvatar :ini="person.initials" :color="person.tone" size="lg" :pres="person.presenceClass" /><div><b>{{ person.name }}</b><small>{{ person.presence || 'Not online' }}</small></div></div>
        <button class="btn sm" disabled title="Coming soon" style="margin-top:10px"><ConvIcon name="video" />Call</button>
      </div>
    </template>
  </aside>
</template>
