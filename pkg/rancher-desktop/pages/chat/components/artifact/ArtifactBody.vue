<!--
  Router that picks the right artifact pane by `artifact.kind`.
-->
<template>
  <div class="artifact-body">
    <div class="artifact-pane">
      <WorkflowArtifact v-if="artifact.kind === 'workflow'" :payload="payload as WorkflowPayload" />
      <HtmlArtifact     v-else-if="artifact.kind === 'html'"  :payload="payload as HtmlPayload" />
      <CodeArtifact     v-else-if="artifact.kind === 'code'"  :payload="payload as CodePayload" />
      <div v-else class="empty">No content for this artifact.</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Artifact, WorkflowPayload, HtmlPayload, CodePayload } from '../../models/Artifact';

import WorkflowArtifact from './panes/WorkflowArtifact.vue';
import HtmlArtifact     from './panes/HtmlArtifact.vue';
import CodeArtifact     from './panes/CodeArtifact.vue';

const props = defineProps<{ artifact: Artifact }>();

const payload = computed(() => props.artifact.payload ?? placeholderPayload(props.artifact.kind));

function placeholderPayload(kind: Artifact['kind']): WorkflowPayload | HtmlPayload | CodePayload {
  if (kind === 'workflow') {
    return {
      nodes: [
        { id: 'n1', x: 20,  y: 60,  kicker: 'Start',    name: 'Trigger', state: 'start' },
        { id: 'n2', x: 220, y: 60,  kicker: 'Fetch',    name: 'Fetch data', state: 'done' },
        { id: 'n3', x: 430, y: 60,  kicker: 'Reason',   name: 'Draft reply', state: 'active' },
        { id: 'n4', x: 640, y: 60,  kicker: 'Dispatch', name: 'Send', state: 'idle' },
      ],
      edges: [
        { from: 'n1', to: 'n2', state: 'done' },
        { from: 'n2', to: 'n3', state: 'active' },
        { from: 'n3', to: 'n4', state: 'idle' },
      ],
    };
  }
  if (kind === 'html') {
    return { html: '<!doctype html><html><body style="background:#0d1117;color:#e6edf3;font-family:sans-serif;padding:24px"><h1>Blank HTML artifact</h1><p>Nothing to show yet.</p></body></html>' };
  }
  return { path: 'placeholder.ts', language: 'typescript', lines: [{ n: 1, text: '// empty', op: 'context' }] };
}
</script>

<style scoped>
.artifact-body { flex: 1; overflow-y: auto; position: relative; }
.artifact-body::-webkit-scrollbar { width: 6px; }
.artifact-body::-webkit-scrollbar-track { background: transparent; }
.artifact-body::-webkit-scrollbar-thumb { background: rgba(168, 192, 220, 0.2); border-radius: 3px; }
.artifact-pane { height: 100%; padding: 24px 22px; }
.empty { color: var(--read-4); font-family: var(--mono); font-size: 12px; }
</style>
