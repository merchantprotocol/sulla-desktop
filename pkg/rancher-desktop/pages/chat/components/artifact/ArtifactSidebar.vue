<!--
  ArtifactSidebar — container. Slides in from the right when one or
  more artifacts are open. Tabs + header + body.
-->
<template>
  <aside v-if="visible" class="artifact">
    <ArtifactTabs />
    <template v-if="active">
      <ArtifactHeader :artifact="active" @expand="onExpand" />
      <ArtifactBody :artifact="active" />
    </template>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import ArtifactTabs   from './ArtifactTabs.vue';
import ArtifactHeader from './ArtifactHeader.vue';
import ArtifactBody   from './ArtifactBody.vue';

import { useChatController } from '../../controller/useChatController';

const controller = useChatController();
const visible = computed(() => controller.artifacts.value.list.length > 0);
const active  = computed(() => controller.activeArtifact.value);

function onExpand(): void {
  // Phase-3 hook — a future full-screen artifact viewer.
}
</script>

<style scoped>
.artifact {
  overflow: hidden;
  border-left: 1px solid rgba(168, 192, 220, 0.1);
  background: rgba(7, 13, 26, 0.55);
  backdrop-filter: blur(10px);
  display: flex; flex-direction: column;
  height: 100%;
}
</style>
