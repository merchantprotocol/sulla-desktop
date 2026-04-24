<!--
  ArtifactSidebar — container. Slides in from the right when one or
  more artifacts are open. Tabs + header + body.
-->
<template>
  <aside v-if="visible" class="artifact" :class="{ expanded }">
    <ArtifactTabs />
    <template v-if="active">
      <ArtifactHeader :artifact="active" @expand="onExpand" />
      <ArtifactBody :artifact="active" />
    </template>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import ArtifactTabs   from './ArtifactTabs.vue';
import ArtifactHeader from './ArtifactHeader.vue';
import ArtifactBody   from './ArtifactBody.vue';

import { useChatController } from '../../controller/useChatController';

const controller = useChatController();
const visible  = computed(() => controller.artifacts.value.list.length > 0);
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
  border-left: 1px solid rgba(168, 192, 220, 0.1);
  background: #0d131f;
  backdrop-filter: blur(10px);
  display: flex; flex-direction: column;
  height: 100%;
  transition: width 0.3s ease;
}
.artifact.expanded {
  width: 70vw !important;
}
</style>
