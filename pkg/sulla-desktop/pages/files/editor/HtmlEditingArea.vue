<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="html-builder-host">
    <div ref="host" class="html-builder-mount" />
    <Teleport
      v-if="toolbar"
      :to="toolbar"
    >
      <slot name="download" />
    </Teleport>
  </div>
</template>
<script setup lang="ts">
import { html } from '@codemirror/lang-html';
import { EditorView } from '@codemirror/view';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createEditor, textPatch, type EditorCollaboration } from './codeMirror';
import './html-builder/html-builder.css';
import './html-builder/html-builder.js';

type Peer={id:string;name:string;kind:'user'|'agent'};
type Builder={setFilePath:(value:string)=>void;setSource:(value:string)=>void;setSavedSource:(value:string)=>void;setPreviewUrl:(value:string)=>void;setSaveState:(value:string)=>void;setPeers:(value:Peer[])=>void;setReadOnly:(value:boolean)=>void;setNavigationState:(canBack:boolean,canForward:boolean)=>void;destroy:()=>void};
type BuilderApi={mount:(host:HTMLElement,options:Record<string,unknown>)=>Builder};
declare global { var SullaHtmlBuilder:BuilderApi }
const props=defineProps<{modelValue:string;readOnly:boolean;live?:EditorCollaboration|null;fileName?:string;filePath?:string;saveState?:string;peers?:Peer[];onBack?:()=>void;onRename?:(name:string)=>Promise<void>|void;onHistory?:()=>void;onShare?:()=>void;onSave?:()=>Promise<void>|void;onCreateBookmark?:()=>Promise<void>|void;assetBaseUrl?:string;previewUrl?:string;savedSource?:string;onOpenInBrowser?:()=>void;onNavigate?:(href:string)=>void;onOpenExternal?:(href:string)=>void;canBack?:boolean;canForward?:boolean;onNavigateHistory?:(direction:'back'|'forward')=>void}>();
const emit=defineEmits<{'update:modelValue':[value:string]}>();
const toolbar = ref<HTMLElement>();
const host=ref<HTMLElement>();let builder:Builder|undefined;
function sourceEditorFactory(parent:HTMLElement,{value,readOnly,onChange}:{value:string;readOnly:boolean;onChange:(value:string)=>void}){
  let applying=false;const view=createEditor(parent,value,readOnly,false,next=>{if(!applying)onChange(next)},[html()],props.live);
  return{setValue(next:string){const before=view.state.doc.toString();if(before!==next){applying=true;view.dispatch({changes:textPatch(before,next)});applying=false}},getValue(){return view.state.doc.toString()},revealRange(from:number,to:number){view.dispatch({selection:{anchor:from,head:to},effects:EditorView.scrollIntoView(from,{y:'center'})});view.focus()},focus(){view.focus()},destroy(){view.destroy()}};
}
function setToolbar(element: HTMLElement) { toolbar.value = element }
function mount(){if(!host.value)return;builder=globalThis.SullaHtmlBuilder.mount(host.value,{onToolbarChange: setToolbar, source:props.modelValue,savedSource:props.savedSource??props.modelValue,previewUrl:props.previewUrl,fileName:props.fileName,filePath:props.filePath,readOnly:props.readOnly,saveState:props.saveState,peers:props.peers,sourceEditorFactory,onChange:(value:string)=>emit('update:modelValue',value),onBack:props.onBack,onRename:props.onRename,onHistory:props.onHistory,onShare:props.onShare,onSave:props.onSave,onCreateBookmark:props.onCreateBookmark,assetBaseUrl:props.assetBaseUrl,onOpenInBrowser:props.onOpenInBrowser,onNavigate:props.onNavigate,onOpenExternal:props.onOpenExternal,canBack:props.canBack,canForward:props.canForward,onNavigateHistory:props.onNavigateHistory})}
onMounted(mount);onBeforeUnmount(()=>builder?.destroy());
watch(()=>props.modelValue,value=>builder?.setSource(value));watch(()=>props.savedSource,value=>builder?.setSavedSource(value??''));watch(()=>props.previewUrl,value=>builder?.setPreviewUrl(value??''));watch(()=>props.filePath,value=>builder?.setFilePath(value));watch(()=>props.readOnly,value=>builder?.setReadOnly(value));watch(()=>props.saveState,value=>builder?.setSaveState(value==='merged'?'saved':value||'saved'));watch(()=>props.peers,value=>builder?.setPeers(value||[]));watch(()=>[props.canBack,props.canForward],()=>builder?.setNavigationState(Boolean(props.canBack),Boolean(props.canForward)));
</script>
<style scoped>.html-builder-host,.html-builder-mount{position:absolute;inset:0;min-height:0}</style>
