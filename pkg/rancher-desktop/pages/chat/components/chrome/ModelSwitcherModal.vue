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
            v-for="m in filtered"
            :key="m.id"
            :class="['mitem', { active: m.id === controller.model.value.id }]"
            @click="pick(m)"
          >
            <span class="name">{{ m.name }}</span>
            <span :class="['tier', m.tier]">{{ m.tier }}</span>
            <span class="ctx">{{ m.ctx }}</span>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useChatController } from '../../controller/useChatController';
import { defaultModels } from '../../services/ModelRegistry';
import type { ModelDescriptor } from '../../models/Thread';

const controller = useChatController();
const open = computed(() => controller.modals.value.which === 'model');
const query = ref('');

const filtered = computed(() => {
  const q = query.value.toLowerCase();
  return defaultModels.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
});

function pick(m: ModelDescriptor): void {
  controller.switchModel(m);
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
.mlist { padding: 6px 0; max-height: 320px; overflow-y: auto; }
.mitem {
  padding: 10px 18px;
  display: flex; align-items: center; gap: 12px;
  cursor: pointer; transition: background 0.1s ease;
}
.mitem:hover { background: rgba(80, 150, 179, 0.1); }
.mitem .name {
  font-family: var(--mono); font-size: 12.5px; color: var(--read-1); font-weight: 600;
}
.mitem .tier {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--steel-400);
  padding: 1px 7px; border-radius: 3px;
  background: rgba(80, 150, 179, 0.12);
  border: 1px solid rgba(80, 150, 179, 0.22);
}
.mitem .tier.local {
  color: var(--ok);
  background: rgba(134, 239, 172, 0.08);
  border-color: rgba(134, 239, 172, 0.22);
}
.mitem .ctx {
  margin-left: auto;
  font-family: var(--mono); font-size: 10px; color: var(--read-4);
}
.mitem.active { background: rgba(80, 150, 179, 0.14); }
.mitem.active::before { content: "◆"; color: var(--steel-400); margin-right: -4px; }

.veil-enter-active, .veil-leave-active { transition: opacity 0.18s ease; }
.veil-enter-from,   .veil-leave-to    { opacity: 0; }
</style>
