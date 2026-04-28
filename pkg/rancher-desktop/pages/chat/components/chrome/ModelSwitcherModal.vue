<template>
  <Transition name="veil">
    <div v-if="open" class="modal-veil" @click.self="controller.closeModal()">
      <div class="modal">
        <div class="mhead">
          <span>Switch model · ⌘K</span>
          <button class="x" type="button" @click="controller.closeModal()">✕</button>
        </div>
        <div class="msearch">
          <input v-model="query" type="text" placeholder="search models…" autofocus>
        </div>
        <div class="mlist">
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
              :class="['mitem', { active: m.isActiveModel }]"
              @click="pick(m)"
            >
              <span class="name">{{ m.modelLabel }}</span>
              <span v-if="m.isActiveModel" class="tier active">active</span>
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

import type { ModelOption } from '@pkg/pages/agent/AgentModelSelectorController';

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
// IPC state-changed broadcasts keep them fresh automatically.
watch(open, (isOpen) => {
  if (isOpen && providerGroups.value.length === 0 && !selector.loadingProvidersValue) {
    selector.refresh();
  }
});

async function pick(option: ModelOption): Promise<void> {
  await selector.selectModel(option);
  controller.closeModal();
}
</script>

<style scoped>
.modal-veil {
  position: absolute; inset: 0; z-index: 80;
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 15vh;
  background: rgba(7, 13, 26, 0.7); backdrop-filter: blur(8px);
}
.modal {
  width: 480px; max-width: calc(100vw - 48px);
  background: rgba(20, 30, 42, 0.95);
  border: 1px solid rgba(80, 150, 179, 0.3);
  border-radius: 12px; overflow: hidden;
  box-shadow: 0 30px 60px rgba(0,0,0,0.6);
}
.mhead {
  padding: 12px 18px;
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.28em;
  text-transform: uppercase; color: var(--steel-400);
  border-bottom: 1px solid rgba(80, 150, 179, 0.15);
  display: flex; align-items: center; gap: 12px;
}
.mhead .x {
  margin-left: auto; background: transparent; border: none;
  color: var(--read-4); cursor: pointer; font-size: 14px;
}
.msearch { padding: 12px 18px; border-bottom: 1px solid rgba(80, 150, 179, 0.1); }
.msearch input {
  width: 100%; background: transparent; border: none; outline: none;
  color: var(--read-1);
  font-family: var(--serif); font-style: italic; font-size: 16px;
  caret-color: var(--steel-400);
}
.msearch input::placeholder { color: var(--read-4); }
.mlist { padding: 6px 0; max-height: 360px; overflow-y: auto; }

/* Themed scrollbar for the model list */
.mlist::-webkit-scrollbar {
  width: 8px;
}
.mlist::-webkit-scrollbar-track {
  background: transparent;
}
.mlist::-webkit-scrollbar-thumb {
  background: rgba(80, 150, 179, 0.3);
  border-radius: 4px;
}
.mlist::-webkit-scrollbar-thumb:hover {
  background: rgba(80, 150, 179, 0.5);
}

.mgroup-head {
  padding: 10px 18px 4px;
  display: flex; align-items: center; gap: 8px;
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.2em;
  text-transform: uppercase;
}
.mgroup-head .provider { color: var(--steel-400); font-weight: 600; }
.mgroup-head .primary-pill {
  color: var(--steel-300);
  background: rgba(80, 150, 179, 0.14);
  border: 1px solid rgba(80, 150, 179, 0.28);
  padding: 1px 7px; border-radius: 3px;
  font-size: 8.5px;
}

.mdivider {
  height: 1px; margin: 6px 18px;
  background: rgba(80, 150, 179, 0.1);
}

.mempty {
  padding: 14px 18px;
  font-family: var(--mono); font-size: 11px; color: var(--read-4);
}
.mempty-sub { padding-top: 4px; padding-bottom: 10px; }

.mitem {
  padding: 10px 18px;
  display: flex; align-items: center; gap: 12px;
  cursor: pointer; transition: background 0.1s ease;
}
.mitem:hover { background: rgba(80, 150, 179, 0.1); }
.mitem .name {
  font-family: var(--mono); font-size: 12.5px; color: var(--read-1); font-weight: 600;
  flex: 1; min-width: 0;
  white-space: nowrap; text-overflow: ellipsis; overflow: hidden;
}
.mitem .tier {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--steel-400);
  padding: 1px 7px; border-radius: 3px;
  background: rgba(80, 150, 179, 0.12);
  border: 1px solid rgba(80, 150, 179, 0.22);
  flex-shrink: 0;
}
.mitem .tier.active {
  color: var(--ok);
  background: rgba(134, 239, 172, 0.08);
  border-color: rgba(134, 239, 172, 0.22);
}
.mitem.active { background: rgba(80, 150, 179, 0.14); }
.mitem.active::before { content: "◆"; color: var(--steel-400); margin-right: -4px; }

.veil-enter-active, .veil-leave-active { transition: opacity 0.18s ease; }
.veil-enter-from,   .veil-leave-to    { opacity: 0; }
</style>
