<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <Transition name="veil">
    <div v-if="open" class="modal-veil" @click.self="controller.closeModal()">
      <div class="modal">
        <div class="mhead">
          <span>Switch agent or model · ⌘K</span>
          <button class="x" type="button" @click="controller.closeModal()">✕</button>
        </div>
        <div class="msearch">
          <input v-model="query" type="text" placeholder="search agents and models…" autofocus>
        </div>
        <label class="mgroup-head">
          <input type="checkbox" :checked="controller.thread.value.runLocation === 'container'" @change="setRunLocation">
          Run in container
        </label>
        <div class="mlist">
          <template v-if="filteredAgents.length">
            <div class="mgroup-head">
              <span class="provider">Agents</span>
            </div>
            <div
              v-for="a in filteredAgents"
              :key="`agent-${a.slug}`"
              :class="['mitem', { active: a.slug === activeAgentId }]"
              :title="a.description || a.slug"
              @click="pickAgent(a)"
            >
              <span class="name">{{ a.name }}</span>
              <span v-if="a.slug === activeAgentId" class="tier active">active</span>
              <span v-else class="tier">{{ a.model || 'default' }}</span>
            </div>
            <div v-if="filteredGroups.length" class="mdivider" />
          </template>

          <div
            v-if="selector.loadingProvidersValue && providerGroups.length === 0"
            class="mempty"
          >
            Loading providers…
          </div>
          <div
            v-else-if="providerGroups.length === 0"
            class="mempty"
          >
            No providers connected
          </div>

          <template
            v-for="(group, gIdx) in filteredGroups"
            :key="group.providerId"
          >
            <div v-if="gIdx > 0" class="mdivider" />

            <div class="mgroup-head">
              <span class="provider">{{ group.providerName }}</span>
              <span v-if="group.isActiveProvider" class="primary-pill">Primary</span>
            </div>

            <div
              v-if="group.loading"
              class="mempty mempty-sub"
            >
              Loading models…
            </div>

            <div
              v-for="m in group.models"
              :key="`${ group.providerId }-${ m.modelId }`"
              :class="['mitem', { active: m.isActiveModel && !activeAgentId }]"
              @click="pick(m)"
            >
              <span class="name">{{ m.modelLabel }}</span>
              <span v-if="m.isActiveModel && !activeAgentId" class="tier active">active</span>
              <span v-else class="tier">{{ group.providerId }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { AgentOption, ModelOption } from '@pkg/pages/agent/AgentModelSelectorController';

import { useChatController, useModelSelector } from '../../controller/useChatController';

const controller = useChatController();
const selector   = useModelSelector();

const open  = computed(() => controller.modals.value.which === 'model');
const query = ref('');

// Reactive view into the selector's provider groups. Reading `.value`
// here locks in Vue reactivity so ref-driven updates from the main-
// process IPC broadcasts ("model-provider:state-changed") re-render
// the list automatically.
const providerGroups = computed(() => selector.providerGroups.value);

const activeAgentId = computed(() => selector.activeAgentId.value);

const filteredAgents = computed(() => {
  const q = query.value.trim().toLowerCase();
  const agents = selector.agentOptions.value;
  if (!q) return agents;
  return agents.filter(a =>
    a.name.toLowerCase().includes(q) ||
    a.slug.toLowerCase().includes(q) ||
    (a.description ?? '').toLowerCase().includes(q),
  );
});

const filteredGroups = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return providerGroups.value;
  return providerGroups.value
    .map(g => ({
      ...g,
      models: g.models.filter(m =>
        m.modelLabel.toLowerCase().includes(q) ||
        m.modelId.toLowerCase().includes(q) ||
        g.providerName.toLowerCase().includes(q),
      ),
    }))
    .filter(g => g.models.length > 0);
});

// First time the modal opens, ask the selector to load provider groups
// so the list is populated. Subsequent opens reuse the cached groups —
// IPC state-changed broadcasts keep them fresh automatically. Agents are
// re-read on every open so ones created in the Agents tab show up.
watch(open, (isOpen) => {
  if (!isOpen) return;
  if (providerGroups.value.length === 0 && !selector.loadingProvidersValue) {
    selector.refresh();
  } else {
    selector.refreshAgents();
  }
});

function setRunLocation(event: Event): void {
  controller.thread.value = { ...controller.thread.value, runLocation: (event.target as HTMLInputElement).checked ? 'container' : 'vm' };
}

async function pick(option: ModelOption): Promise<void> {
  await selector.selectModel(option);
  controller.closeModal();
}

function pickAgent(agent: AgentOption): void {
  selector.selectAgent(agent);
  controller.closeModal();
}
</script>

<style scoped>
.modal-veil {
  position: absolute; inset: 0; z-index: 80;
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 15vh;
  background: var(--bg-overlay); backdrop-filter: blur(8px);
}
.modal {
  width: 480px; max-width: calc(100vw - 48px);
  background: var(--bg-elevated);
  border: 1px solid var(--accent-glow);
  border-radius: 12px; overflow: hidden;
  box-shadow: 0 30px 60px var(--bg-page);
}
.mhead {
  padding: 12px 18px;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.28em;
  text-transform: uppercase; color: var(--accent-hover);
  border-bottom: 1px solid var(--accent-dim);
  display: flex; align-items: center; gap: 12px;
}
.mhead .x {
  margin-left: auto; background: transparent; border: none;
  color: var(--text-muted); cursor: pointer; font-size: 14px;
}
.msearch { padding: 12px 18px; border-bottom: 1px solid var(--accent-dim); }
.msearch input {
  width: 100%; background: transparent; border: none; outline: none;
  color: var(--text-primary);
  font-family: var(--font-display); font-style: italic; font-size: 16px;
  caret-color: var(--accent-hover);
}
.msearch input::placeholder { color: var(--text-muted); }
.mlist { padding: 6px 0; max-height: 360px; overflow-y: auto; }

/* Themed scrollbar for the model list */
.mlist::-webkit-scrollbar {
  width: 8px;
}
.mlist::-webkit-scrollbar-track {
  background: transparent;
}
.mlist::-webkit-scrollbar-thumb {
  background: var(--accent-glow);
  border-radius: 4px;
}
.mlist::-webkit-scrollbar-thumb:hover {
  background: var(--accent-glow);
}

.mgroup-head {
  padding: 10px 18px 4px;
  display: flex; align-items: center; gap: 8px;
  font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.2em;
  text-transform: uppercase;
}
.mgroup-head .provider { color: var(--accent-hover); font-weight: 600; }
.mgroup-head .primary-pill {
  color: var(--accent-hover);
  background: var(--accent-dim);
  border: 1px solid var(--accent-dim);
  padding: 1px 7px; border-radius: 3px;
  font-size: 8.5px;
}

.mdivider {
  height: 1px; margin: 6px 18px;
  background: var(--accent-dim);
}

.mempty {
  padding: 14px 18px;
  font-family: var(--font-mono); font-size: 11px; color: var(--text-muted);
}
.mempty-sub { padding-top: 4px; padding-bottom: 10px; }

.mitem {
  padding: 10px 18px;
  display: flex; align-items: center; gap: 12px;
  cursor: pointer; transition: background 0.1s ease;
}
.mitem:hover { background: var(--accent-dim); }
.mitem .name {
  font-family: var(--font-mono); font-size: 12.5px; color: var(--text-primary); font-weight: 600;
  flex: 1; min-width: 0;
  white-space: nowrap; text-overflow: ellipsis; overflow: hidden;
}
.mitem .tier {
  font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--accent-hover);
  padding: 1px 7px; border-radius: 3px;
  background: var(--accent-dim);
  border: 1px solid var(--accent-dim);
  flex-shrink: 0;
}
.mitem .tier.active {
  color: var(--status-success);
  background: var(--status-success-soft);
  border-color: var(--status-success-soft);
}
.mitem.active { background: var(--accent-dim); }
.mitem.active::before { content: "◆"; color: var(--accent-hover); margin-right: -4px; }

.veil-enter-active, .veil-leave-active { transition: opacity 0.18s ease; }
.veil-enter-from,   .veil-leave-to    { opacity: 0; }
</style>
