<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
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
    <button
      class="collapse"
      type="button"
      title="Collapse artifacts"
      aria-label="Collapse artifacts panel"
      @click="emit('collapse')"
    >›</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useChatController } from '../../controller/useChatController';
import type { ArtifactKind } from '../../models/Artifact';

const emit = defineEmits<{ collapse: [] }>();
const controller = useChatController();
const artifacts = computed(() => controller.artifacts.value.list);
const activeId  = computed(() => controller.artifacts.value.activeId);

function iconFor(kind: ArtifactKind): string {
  return ({ workflow: '⌘', html: '▦', code: '‹›', markdown: '☷' })[kind];
}
</script>

<style scoped>
.artifact-tabs {
  display: flex; align-items: center; gap: 4px;
  padding: 14px 14px 0;
  border-bottom: 1px solid var(--accent-dim);
}
.atab {
  padding: 9px 14px; border-radius: 8px 8px 0 0;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--text-secondary);
  cursor: pointer;
  border: 1px solid transparent; border-bottom: none;
  display: inline-flex; align-items: center; gap: 8px;
  transition: all 0.15s ease;
}
.atab:hover { color: var(--text-secondary); background: var(--accent-dim); }
.atab.active {
  color: var(--text-on-accent);
  background: var(--accent-dim);
  border-color: var(--accent-dim);
}
.atab .ic { color: var(--accent-hover); font-size: 11px; }
.atab .x {
  width: 14px; height: 14px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; color: var(--text-muted); background: transparent;
  border: none; cursor: pointer; margin-left: 4px;
}
.atab .x:hover { color: var(--status-error); background: var(--status-warning-soft); }
.atab .running-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent-hover); box-shadow: 0 0 8px var(--accent-hover);
  animation: chat-pulse 1.5s infinite;
}
.atab .done-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--status-success); }
.collapse {
  margin-left: auto; align-self: center; flex: 0 0 auto;
  padding: 0 7px; border: none; border-radius: 6px;
  background: transparent; color: var(--text-secondary);
  font-size: 16px; line-height: 22px; cursor: pointer;
}
.collapse:hover { color: var(--text-secondary); background: var(--accent-dim); }
</style>
