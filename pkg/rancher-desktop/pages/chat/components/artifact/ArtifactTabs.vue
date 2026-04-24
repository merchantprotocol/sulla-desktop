<!-- Row of tabs — one per active artifact. Click switches, ✕ closes. -->
<template>
  <div class="artifact-tabs">
    <div
      v-for="a in artifacts"
      :key="a.id"
      :class="['atab', { active: a.id === activeId }]"
      @click="controller.switchArtifact(a.id)"
    >
      <span class="ic">{{ iconFor(a.kind) }}</span>
      <span v-if="a.status === 'working' || a.status === 'editing'" class="running-dot" />
      <span v-else-if="a.status === 'done'" class="done-dot" />
      <span>{{ a.name }}</span>
      <button
        class="x"
        type="button"
        :aria-label="'Close ' + a.name"
        @click.stop="controller.closeArtifact(a.id)"
      >✕</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useChatController } from '../../controller/useChatController';
import type { ArtifactKind } from '../../models/Artifact';

const controller = useChatController();
const artifacts = computed(() => controller.artifacts.value.list);
const activeId  = computed(() => controller.artifacts.value.activeId);

function iconFor(kind: ArtifactKind): string {
  return ({ workflow: '⌘', html: '▦', code: '‹›' })[kind];
}
</script>

<style scoped>
.artifact-tabs {
  display: flex; align-items: center; gap: 4px;
  padding: 14px 14px 0;
  border-bottom: 1px solid rgba(168, 192, 220, 0.08);
}
.atab {
  padding: 9px 14px; border-radius: 8px 8px 0 0;
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--read-3);
  cursor: pointer;
  border: 1px solid transparent; border-bottom: none;
  display: inline-flex; align-items: center; gap: 8px;
  transition: all 0.15s ease;
}
.atab:hover { color: var(--steel-100); background: rgba(80, 150, 179, 0.06); }
.atab.active {
  color: white;
  background: rgba(80, 150, 179, 0.12);
  border-color: rgba(80, 150, 179, 0.25);
}
.atab .ic { color: var(--steel-400); font-size: 11px; }
.atab .x {
  width: 14px; height: 14px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; color: var(--read-4); background: transparent;
  border: none; cursor: pointer; margin-left: 4px;
}
.atab .x:hover { color: var(--err); background: rgba(252, 165, 165, 0.12); }
.atab .running-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--steel-400); box-shadow: 0 0 8px var(--steel-400);
  animation: chat-pulse 1.5s infinite;
}
.atab .done-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
</style>
