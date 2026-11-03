<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="sd-panel-tabs">
    <div ref="tabWrap" class="sd-tab-wrap" role="tablist">
      <button
        v-for="a in artifacts"
        :key="a.id"
        class="sd-panel-tab"
        :aria-selected="!agentActive && a.id === activeId"
        @click="selectArtifact(a.id)"
      >
        <i v-if="a.status === 'working' || a.status === 'editing'" class="sd-tab-dot is-running" />
        <i v-else-if="a.status === 'done'" class="sd-tab-dot is-done" />
        {{ a.name }}
      </button>
      <button
        v-if="showAgent"
        class="sd-panel-tab"
        :aria-selected="agentActive"
        @click="emit('agent-select')"
      >
        Agent
      </button>
      <span class="sd-tab-indicator" :style="indicatorStyle" />
    </div>
    <span class="spacer" />
    <button class="sd-icon" title="Close panel" aria-label="Close panel" @click="emit('collapse')">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useChatController } from '../../controller/useChatController';

const props = defineProps<{ showAgent?: boolean; agentActive?: boolean }>();
const emit = defineEmits<{ collapse: []; 'agent-select': []; 'artifact-select': [] }>();
const controller = useChatController();
const artifacts = computed(() => controller.artifacts.value.list);
const activeId = computed(() => controller.artifacts.value.activeId);
const tabWrap = ref<HTMLElement | null>(null);
const indicatorStyle = ref({ width: '0px', transform: 'translateX(0)' });

function placeIndicator(): void {
  void nextTick(() => {
    const selected = tabWrap.value?.querySelector<HTMLElement>('.sd-panel-tab[aria-selected="true"]');
    if (!selected) {
      indicatorStyle.value = { width: '0px', transform: 'translateX(0)' };
      return;
    }
    indicatorStyle.value = {
      width: `${Math.max(0, selected.offsetWidth - 20)}px`,
      transform: `translateX(${selected.offsetLeft + 10}px)`,
    };
  });
}

function selectArtifact(id: string): void {
  controller.switchArtifact(id);
  emit('artifact-select');
}

watch([activeId, () => props.agentActive, () => props.showAgent, artifacts], placeIndicator, {
  deep: true,
  flush: 'post',
});
onMounted(() => {
  placeIndicator();
  window.addEventListener('resize', placeIndicator);
});
onBeforeUnmount(() => window.removeEventListener('resize', placeIndicator));
</script>

<style scoped>
.sd-panel-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 10px 6px 12px;
  border-bottom: 1px solid var(--border-default);
}
.sd-tab-wrap {
  position: relative;
  display: flex;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}
.sd-panel-tab {
  font: inherit;
  height: 32px;
  max-width: 125px;
  padding: 0 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}
.sd-panel-tab:hover {
  color: var(--text-primary);
}
.sd-panel-tab[aria-selected='true'] {
  color: var(--accent-primary);
  font-weight: 500;
}
.sd-tab-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 4px;
  border-radius: 50%;
  vertical-align: 1px;
}
.sd-tab-dot.is-running {
  background: var(--accent-primary);
  animation: chat-pulse 1.5s infinite;
}
.sd-tab-dot.is-done {
  background: var(--text-success);
}
.sd-tab-indicator {
  position: absolute;
  bottom: 0;
  height: 2px;
  border-radius: 2px;
  background: var(--accent-primary);
  transition: transform 580ms linear(0, 0.006, 0.025 2.8%, 0.101 6.1%, 0.539 18.9%, 0.849 31.5%, 0.968 41.8%, 1.006 50.1%, 1.017 63.9%, 1),
    width 580ms;
}
.spacer { flex: 1; }
.sd-icon {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.sd-icon:hover {
  background: var(--bg-surface-alt);
  color: var(--text-primary);
}
.sd-icon svg {
  width: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
}
</style>
