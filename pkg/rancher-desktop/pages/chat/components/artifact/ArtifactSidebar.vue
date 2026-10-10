<!--
  ArtifactSidebar — container. Slides in from the right when one or
  more artifacts are open. Tabs + header + body.
-->
<template>
  <aside v-if="visible && !collapsed" class="artifact" :class="{ expanded }">
    <ArtifactTabs @collapse="emit('toggle-collapse')" />
    <template v-if="active">
      <ArtifactHeader :artifact="active" @expand="onExpand" />
      <ArtifactBody :artifact="active" />
    </template>
  </aside>
  <button
    v-else-if="visible"
    type="button"
    class="artifact-tab"
    :class="{ working }"
    title="Show artifacts"
    aria-label="Show artifacts panel"
    @click="emit('toggle-collapse')"
  >
    <span class="tab-chevron">‹</span>
    <span class="tab-label">Artifacts · {{ count }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import ArtifactTabs   from './ArtifactTabs.vue';
import ArtifactHeader from './ArtifactHeader.vue';
import ArtifactBody   from './ArtifactBody.vue';

import { useChatController } from '../../controller/useChatController';

defineProps<{ collapsed?: boolean }>();
const emit = defineEmits<{ 'toggle-collapse': [] }>();

const controller = useChatController();
const count    = computed(() => controller.artifacts.value.list.length);
const visible  = computed(() => count.value > 0);
const working  = computed(() => controller.artifacts.value.list.some(a => a.status === 'working' || a.status === 'editing'));
const active   = computed(() => controller.activeArtifact.value);
const expanded = ref(false);

// Collapse when artifacts are all closed.
watch(visible, v => { if (!v) expanded.value = false; });

function onExpand(): void {
  expanded.value = !expanded.value;
  window.dispatchEvent(new CustomEvent('chat:artifact-expand', {
    detail: { expanded: expanded.value },
  }));
}
</script>

<style scoped>
/*
  Sidebar sits a notch lighter than the chat background (#050810) so
  the eye reads it as its own surface without needing an inner card.
*/
.artifact {
  overflow: hidden;
  border-left: 1px solid var(--border-default, rgba(168, 192, 220, 0.1));
  background: var(--bg-surface, #0d131f);
  backdrop-filter: blur(10px);
  display: flex; flex-direction: column;
  height: 100%;
  transition: width 0.3s ease;
}
.artifact.expanded {
  width: 70vw !important;
}

/* Collapsed: a slim tab sticks out of the right edge where the sidebar was. */
.artifact-tab {
  position: absolute;
  top: 50%; right: 0;
  z-index: 6;
  transform: translateY(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 12px 5px;
  border: 1px solid var(--border-default, rgba(168, 192, 220, 0.1));
  border-right: none;
  border-radius: 9px 0 0 9px;
  background: var(--bg-surface, #0d131f);
  color: var(--read-3);
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, padding 0.15s ease;
}
.artifact-tab:hover { color: var(--steel-100); border-color: rgba(80, 150, 179, 0.4); padding-left: 8px; }
.artifact-tab.working { border-color: rgba(80, 150, 179, 0.4); }
.tab-chevron { font-size: 14px; line-height: 1; }
.tab-label {
  writing-mode: vertical-rl;
  font-family: var(--mono); font-size: 10px; font-weight: 600;
  letter-spacing: 0.16em; text-transform: uppercase;
  white-space: nowrap;
}
</style>
