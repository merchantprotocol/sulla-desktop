<template><div ref="host" class="editing-area" /></template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { EditorView } from '@codemirror/view';
import { createEditor } from './codeMirror';
const props=defineProps<{ modelValue:string; readOnly:boolean }>();
const emit=defineEmits<{ 'update:modelValue':[value:string] }>();
const host=ref<HTMLElement>(); let view:EditorView|undefined; let applying=false;
onMounted(()=>{ if(host.value)view=createEditor(host.value,props.modelValue,props.readOnly,false,value=>{if(!applying)emit('update:modelValue',value)}) });
watch(()=>props.modelValue,value=>{if(!view||view.state.doc.toString()===value)return;applying=true;view.dispatch({changes:{from:0,to:view.state.doc.length,insert:value}});applying=false});
onBeforeUnmount(()=>view?.destroy());
</script>
<style scoped>.editing-area{min-height:420px}</style>
