<!--
  Workflow artifact pane.

  Mounts the full AgentRoutines editor for the given workflow id — same
  component as the /routines/:id page. Identical editor, drawer, run
  controls, history, IPC. No second rendering path, no preview fallback,
  no parallel visuals to keep in sync with the real editor.

  Workflow artifacts must carry a saved id. PersonaAdapter refuses to
  open an artifact without one, so this component doesn't need a fallback.
-->
<template>
  <div class="wf-artifact">
    <AgentRoutines
      v-if="payload.id"
      :workflow-id="payload.id"
      initial-mode="edit"
    />
  </div>
</template>

<script setup lang="ts">
import AgentRoutines from '../../../../AgentRoutines.vue';
import type { WorkflowPayload } from '../../../models/Artifact';

defineProps<{ payload: WorkflowPayload }>();
</script>

<style scoped>
.wf-artifact {
  width: 100%;
  height: 100%;
  min-height: 420px;
}

.wf-artifact :deep(.routines-frame) {
  width: 100%;
  height: 100%;
}
</style>
