<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template><div ref="host" class="html-builder-host" /></template>
<script setup lang="ts">
import { html } from '@codemirror/lang-html';
import { EditorView } from '@codemirror/view';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createEditor, textPatch, type EditorCollaboration } from './codeMirror';
import './html-builder/html-builder.css';
import './html-builder/html-builder.js';

type Peer={id:string;name:string;kind:'user'|'agent'};
type Builder={setSource:(value:string)=>void;setSaveState:(value:string)=>void;setPeers:(value:Peer[])=>void;setReadOnly:(value:boolean)=>void;destroy:()=>void};
type BuilderApi={mount:(host:HTMLElement,options:Record<string,unknown>)=>Builder};
declare global { var SullaHtmlBuilder:BuilderApi }
const props=defineProps<{modelValue:string;readOnly:boolean;live?:EditorCollaboration|null;fileName?:string;saveState?:string;peers?:Peer[];onBack?:()=>void;onRename?:(name:string)=>Promise<void>|void;onHistory?:()=>void;onShare?:()=>void;onSave?:()=>Promise<void>|void;assetBaseUrl?:string;onOpenInBrowser?:()=>void}>();
const emit=defineEmits<{'update:modelValue':[value:string]}>();
const host=ref<HTMLElement>();let builder:Builder|undefined;
function sourceEditorFactory(parent:HTMLElement,{value,readOnly,onChange}:{value:string;readOnly:boolean;onChange:(value:string)=>void}){
  const view=createEditor(parent,value,readOnly,false,onChange,[html()],props.live);
  return{setValue(next:string){const before=view.state.doc.toString();if(before!==next)view.dispatch({changes:textPatch(before,next)})},getValue(){return view.state.doc.toString()},revealRange(from:number,to:number){view.dispatch({selection:{anchor:from,head:to},effects:EditorView.scrollIntoView(from,{y:'center'})});view.focus()},focus(){view.focus()},destroy(){view.destroy()}};
}
function mount(){if(!host.value)return;builder=globalThis.SullaHtmlBuilder.mount(host.value,{source:props.modelValue,fileName:props.fileName,readOnly:props.readOnly,saveState:props.saveState,peers:props.peers,sourceEditorFactory,onChange:(value:string)=>emit('update:modelValue',value),onBack:props.onBack,onRename:props.onRename,onHistory:props.onHistory,onShare:props.onShare,onSave:props.onSave,assetBaseUrl:props.assetBaseUrl,onOpenInBrowser:props.onOpenInBrowser})}
onMounted(mount);onBeforeUnmount(()=>builder?.destroy());
watch(()=>props.modelValue,value=>builder?.setSource(value));watch(()=>props.readOnly,value=>builder?.setReadOnly(value));watch(()=>props.saveState,value=>builder?.setSaveState(value||'saved'));watch(()=>props.peers,value=>builder?.setPeers(value||[]));
</script>
<style scoped>.html-builder-host{position:absolute;inset:0;min-height:0}</style>
