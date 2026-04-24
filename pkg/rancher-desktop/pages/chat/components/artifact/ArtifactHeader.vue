<!-- Artifact header — name + status + actions (Expand / Close). -->
<template>
  <div class="artifact-head">
    <div class="name">
      {{ artifact.name }}
      <small>{{ typeLabel }}</small>
    </div>
    <div class="spacer" />
    <div :class="['status', artifact.status === 'done' ? 'done' : '']">
      {{ artifact.status }}
    </div>
    <button class="act" type="button" @click="$emit('expand')">Expand</button>
    <button class="act" type="button" @click="controller.closeArtifact(artifact.id)">Close</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Artifact } from '../../models/Artifact';
import { useChatController } from '../../controller/useChatController';

const props = defineProps<{ artifact: Artifact }>();
defineEmits<{ (e: 'expand'): void }>();
const controller = useChatController();
const typeLabel = computed(() => ({ workflow: 'Workflow', html: 'HTML Artifact', code: 'Code File' })[props.artifact.kind]);
</script>

<style scoped>
.artifact-head {
  padding: 14px 22px;
  display: flex; align-items: center; gap: 14px;
  border-bottom: 1px solid rgba(168, 192, 220, 0.1);
  background: rgba(7, 13, 26, 0.4);
}
.name { font-family: var(--serif); font-style: italic; font-size: 17px; color: white; }
.name small {
  font-family: var(--mono); font-size: 10px; font-style: normal;
  letter-spacing: 0.15em; text-transform: uppercase;
  color: var(--read-4); margin-left: 10px;
}
.spacer { flex: 1; }
.status {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--steel-400);
  display: inline-flex; align-items: center; gap: 8px;
}
.status::before {
  content: ""; width: 6px; height: 6px; border-radius: 50%;
  background: var(--steel-400); box-shadow: 0 0 10px var(--steel-400);
  animation: chat-pulse 1.5s infinite;
}
.status.done { color: var(--ok); }
.status.done::before { background: var(--ok); box-shadow: none; animation: none; }
.act {
  background: transparent; border: 1px solid rgba(168, 192, 220, 0.2);
  color: var(--read-3); padding: 5px 10px; border-radius: 6px;
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.18em;
  text-transform: uppercase; cursor: pointer;
  transition: all 0.15s ease;
}
.act:hover {
  border-color: var(--steel-400); color: var(--steel-100);
  background: rgba(80, 150, 179, 0.08);
}
</style>
