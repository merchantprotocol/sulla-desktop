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
const me = computed(() => store.me());
const counts = computed(() => store.navCounts());
/** Mockup org card subtitle: "Owner · 5 members". The role is your role in the directory; omitted when it sends none. */
const orgSubtitle = computed(() => {
  const members = `${org.value.memberCount} member${org.value.memberCount === 1 ? '' : 's'}`;
  return me.value?.role ? `${me.value.role} · ${members}` : members;
});
/** The bottom identity card: your directory presence and your agent host, or Offline / paused with no network. */
const footStatus = computed(() => {
  if (!me.value) return '';
  if (!store.online()) return 'Offline · Your agent: paused';
  return `${me.value.status} · Your agent: ${me.value.agentOnline ? 'on' : 'off'}`;
});
const relayLabel: Record<string, string> = { connected: 'Connected · Sulla Cloud relay', connecting: 'Connecting · Sulla Cloud relay', offline: 'Offline · Sulla Cloud relay' };
const relayDot: Record<string, string> = { connected: '', connecting: 'warn', offline: 'off' };

function setTab(tab: ListTab): void { store.setListTab(tab); }
</script>

<template>
  <nav class="nav" aria-label="Conversations sections" style="position:relative">
    <div class="brand"><div class="mark"><ConvIcon name="robot" /></div><div><b>Sulla</b><span>Conversations</span></div></div>
    <button class="orgbtn" :class="{ open: store.s.orgMenu }" title="Switch organization" @click="store.toggleOrgMenu()">
      <span class="ochip" :style="{ background: org.gradient }">{{ org.initials }}</span>
      <span class="nm2"><b>{{ org.name || 'No organization' }}</b><small>{{ orgSubtitle }}</small></span>
      <ConvIcon name="chev" />
    </button>
    <a href="#" :class="{ on: store.s.listTab === 'threads' }" @click.prevent="setTab('threads')"><ConvIcon name="chat" /><span>All conversations</span><span v-if="counts.threads" class="cnt hot">{{ counts.threads }}</span></a>
    <!-- Followed threads have no backend yet: shown disabled, with no count. -->
    <a href="#" class="disabled" aria-disabled="true" title="Coming soon" style="opacity:.5;cursor:not-allowed" @click.prevent><ConvIcon name="thread" /><span>Threads</span></a>
    <a href="#" :class="{ on: store.s.listTab === 'people' }" @click.prevent="setTab('people')"><ConvIcon name="people" /><span>People</span><span v-if="counts.people" class="cnt">{{ counts.people }}</span></a>
    <a href="#" :class="{ on: store.s.listTab === 'agents' }" @click.prevent="setTab('agents')"><ConvIcon name="link" /><span>Agent threads</span><span v-if="counts.agents" class="cnt">{{ counts.agents }}</span></a>
    <!-- Meeting notes have no data source yet: shown disabled, with no count. -->
    <a href="#" class="disabled" aria-disabled="true" title="Coming soon" style="opacity:.5;cursor:not-allowed" @click.prevent><ConvIcon name="notes" /><span>Meeting notes</span></a>
    <div class="sep" />
    <a href="#" @click.prevent="store.requestSecretary()"><ConvIcon name="mic" /><span>Start Secretary Mode</span></a>
    <a href="#" class="disabled" aria-disabled="true" title="Coming soon" style="opacity:.5;cursor:not-allowed" @click.prevent><ConvIcon name="shield" /><span class="nm">Who can message my agent</span></a>
    <div v-if="store.relay() !== 'unknown'" class="syncline"><span class="dot" :class="relayDot[store.relay()]" />{{ relayLabel[store.relay()] }}</div>
    <div v-if="me" class="foot"><ConvAvatar :ini="me.initials" color="a" :pres="store.online() ? me.presenceClass : 'offline'" /><div><b>{{ me.name }}</b><small>{{ footStatus }}</small></div></div>

    <div v-if="store.s.orgMenu" class="orgmenu" style="left:10px;top:70px">
      <div class="oh">Your organizations</div>
      <button v-for="item in store.orgs()" :key="item.id" class="orow" :class="{ on: store.s.org === item.id }" @click="store.switchOrg(item.id)">
        <span class="ochip" :style="{ background: item.gradient }">{{ item.initials }}</span>
        <span><b>{{ item.name }}</b><small>{{ item.memberCount }} member{{ item.memberCount === 1 ? '' : 's' }}</small></span>
        <span class="r"><ConvIcon v-if="store.s.org === item.id" name="check" /></span>
      </button>
      <p v-if="!store.orgs().length" class="of">You're not in an organization yet.</p>
    </div>
  </nav>
</template>
