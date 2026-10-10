<template>
  <div
    class="markdown-artifact"
    v-html="rendered"
    @change="onCheckboxChange"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { toggleMarkdownTask } from '../markdownTasks';
import { renderMarkdown } from '../../../messages/markdown';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { Artifact, MarkdownPayload } from '../../../models/Artifact';

const props = defineProps<{ artifact: Artifact & { payload: MarkdownPayload } }>();
const saving = ref(false);

const rendered = computed(() => {
  const template = document.createElement('template');

  template.innerHTML = renderMarkdown(props.artifact.payload.markdown);
  template.content.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox, index) => {
    checkbox.disabled = saving.value;
    checkbox.dataset.taskIndex = String(index);
  });
  return template.innerHTML;
});

watch(() => props.artifact.version, () => { saving.value = false });

async function onCheckboxChange(event: Event): Promise<void> {
  const checkbox = event.target as HTMLInputElement;
  if (!checkbox.matches('input[type="checkbox"][data-task-index]') || saving.value) return;
  const index = Number(checkbox.dataset.taskIndex);
  const content = toggleMarkdownTask(props.artifact.payload.markdown, index, checkbox.checked);
  if (content === props.artifact.payload.markdown) return;

  saving.value = true;
  try {
    await ipcRenderer.invoke('chat-artifacts:save', {
      threadId:       props.artifact.threadId,
      idOrName:       props.artifact.id,
      content,
      expectedVersion: props.artifact.version,
    });
  } catch (err) {
    // Usually a version conflict (the agent edited the plan at the same
    // moment). Put the box back so it matches what's actually saved.
    checkbox.checked = !checkbox.checked;
    console.warn('[MarkdownArtifact] checkbox save failed:', err);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.markdown-artifact {
  color: var(--text, var(--text-primary));
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.theme-noir .markdown-artifact { color: var(--nx-read-2); }

.markdown-artifact :deep(h1),
.markdown-artifact :deep(h2),
.markdown-artifact :deep(h3) {
  color: var(--text, var(--text-primary));
  font-family: var(--font-display);
  line-height: 1.2;
}
.theme-noir .markdown-artifact :deep(h1),
.theme-noir .markdown-artifact :deep(h2),
.theme-noir .markdown-artifact :deep(h3) { color: var(--nx-read-1); }
.markdown-artifact :deep(a) { color: var(--accent, var(--accent-primary)); }
.theme-noir .markdown-artifact :deep(a) { color: var(--nx-accent-2); }
.markdown-artifact :deep(pre),
.markdown-artifact :deep(code) { font-family: var(--font-mono); }
.markdown-artifact :deep(pre) {
  overflow-x: auto;
  padding: 14px;
  border: 1px solid var(--border-muted, var(--border-subtle));
  border-radius: 8px;
  background: var(--surface-2, var(--bg-surface-alt));
}
.theme-noir .markdown-artifact :deep(pre) {
  border-color: var(--nx-hair-strong);
  background: var(--nx-surface);
}
.markdown-artifact :deep(input[type="checkbox"]) {
  accent-color: var(--accent, var(--accent-primary));
  cursor: pointer;
  margin-right: 8px;
}
.theme-noir .markdown-artifact :deep(input[type="checkbox"]) { accent-color: var(--nx-accent-2); }
</style>
