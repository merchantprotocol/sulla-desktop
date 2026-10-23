<template>
  <div class="html-area">
    <div class="view-toggle" role="group" aria-label="HTML view">
      <button type="button" :class="{ active: mode === 'preview' }" @click="mode = 'preview'">Preview</button>
      <button type="button" :class="{ active: mode === 'source' }" @click="mode = 'source'">Source</button>
    </div>
    <iframe v-if="mode === 'preview'" class="preview" :srcdoc="modelValue" title="HTML preview" sandbox="allow-scripts" />
    <div v-else ref="host" class="editing-area" />
  </div>
</template>

<script setup lang="ts">
import { html } from '@codemirror/lang-html';
import type { EditorView } from '@codemirror/view';
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { createEditor, textPatch, type EditorCollaboration } from './codeMirror';

const props = defineProps<{ modelValue:string; readOnly:boolean; live?:EditorCollaboration|null }>();
const emit = defineEmits<{ 'update:modelValue':[value:string] }>();
const mode = ref<'preview' | 'source'>('preview');
const host = ref<HTMLElement>();
let view:EditorView | undefined;
let applying = false;

function destroyEditor() { view?.destroy(); view = undefined }
function build() {
  destroyEditor();
  if (!host.value) return;
  view = createEditor(host.value, props.modelValue, props.readOnly, false, value => {
    if (!applying) emit('update:modelValue', value);
  }, [html()], props.live);
}

watch(mode, async value => { destroyEditor(); if (value === 'source') { await nextTick(); build() } });
watch(() => props.live, () => { if (mode.value === 'source') build() });
watch(() => props.modelValue, value => {
  if (!view || view.state.doc.toString() === value) return;
  applying = true;
  view.dispatch({ changes: textPatch(view.state.doc.toString(), value) });
  applying = false;
});
onBeforeUnmount(destroyEditor);
</script>

<style scoped>
.html-area{position:relative;min-height:520px}.view-toggle{display:flex;justify-content:flex-end;gap:2px;margin:-34px 0 22px}.view-toggle button{border:1px solid var(--nx-border,#dde4ee);padding:5px 12px;background:var(--nx-surface,#fff);color:var(--nx-text-secondary,#5b6878);font-size:12px}.view-toggle button:first-child{border-radius:8px 0 0 8px}.view-toggle button:last-child{margin-left:-3px;border-radius:0 8px 8px 0}.view-toggle button.active{position:relative;border-color:var(--nx-text-primary,#1a2332);background:var(--nx-text-primary,#1a2332);color:#fff}.preview{display:block;width:100%;min-height:600px;border:1px solid var(--nx-border,#dde4ee);border-radius:10px;background:#fff}.editing-area{min-height:520px}
</style>
