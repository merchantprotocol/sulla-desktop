<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { ListTab } from '../ConversationScreenStore';
import { useConvStore } from '../useConvStore';
import ConvAvatar from './ConvAvatar.vue';
import ConvIcon from './ConvIcon.vue';

const store = useConvStore();
const org = computed(() => store.org());
const memberLabel = computed(() => `${org.value.memberCount} member${org.value.memberCount === 1 ? '' : 's'}`);
const tabs: { id: ListTab; label: string; icon: string }[] = [
  { id: 'threads', label: 'All conversations', icon: 'chat' },
  { id: 'people', label: 'People', icon: 'people' },
  { id: 'agents', label: 'Agent threads', icon: 'link' },
];
// Followed threads and meeting notes have no backend yet. They stay visible and disabled.
const unavailable = [
  { label: 'Threads', icon: 'thread' },
  { label: 'Meeting notes', icon: 'notes' },
];

function setTab(tab: ListTab): void { store.setListTab(tab); }
</script>

<template>
  <nav class="nav" aria-label="Conversations sections" style="position:relative">
    <div class="brand"><div class="mark"><ConvIcon name="robot" /></div><div><b>Sulla</b><span>Conversations</span></div></div>
    <button class="orgbtn" :class="{ open: store.s.orgMenu }" title="Switch organization" @click="store.toggleOrgMenu()">
      <span class="ochip">{{ org.initials }}</span>
      <span class="nm2"><b>{{ org.name || 'No organization' }}</b><small>{{ memberLabel }}</small></span>
      <ConvIcon name="chev" />
    </button>
    <a v-for="tab in tabs" :key="tab.id" href="#" :class="{ on: store.s.listTab === tab.id }" @click.prevent="setTab(tab.id)">
      <ConvIcon :name="tab.icon" /><span>{{ tab.label }}</span>
    </a>
    <a v-for="item in unavailable" :key="item.label" href="#" class="disabled" aria-disabled="true" title="Coming soon" style="opacity:.5;cursor:not-allowed" @click.prevent>
      <ConvIcon :name="item.icon" /><span>{{ item.label }}</span><span class="cnt">Coming soon</span>
    </a>
    <div class="sep" />
    <a href="#" @click.prevent="store.requestSecretary()"><ConvIcon name="mic" /><span>Start Secretary Mode</span></a>
    <button class="btn sm ghost" disabled title="Coming soon" style="justify-content:flex-start"><ConvIcon name="shield" />Who can message my agent</button>
    <div class="foot">
      <ConvAvatar :ini="org.initials" color="a" />
      <div><b>{{ store.org().name }}</b><small>Your conversations in this organization</small></div>
    </div>

    <div v-if="store.s.orgMenu" class="orgmenu" style="left:10px;top:70px">
      <div class="oh">Your organizations</div>
      <button v-for="item in store.orgs()" :key="item.id" class="orow" :class="{ on: store.s.org === item.id }" @click="store.switchOrg(item.id)">
        <span class="ochip">{{ item.initials }}</span>
        <span><b>{{ item.name }}</b><small>{{ item.memberCount }} member{{ item.memberCount === 1 ? '' : 's' }}</small></span>
        <span class="r"><ConvIcon v-if="store.s.org === item.id" name="check" /></span>
      </button>
      <p v-if="!store.orgs().length" class="of">You're not in an organization yet.</p>
    </div>
  </nav>
</template>
