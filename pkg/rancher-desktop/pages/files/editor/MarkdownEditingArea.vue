<template>
  <div class="markdown-wrap">
    <div class="block-gutter" aria-hidden="true"><button tabindex="-1" type="button">+</button><button tabindex="-1" type="button">⠿</button></div>
    <div ref="host" class="editing-area" />
  </div>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { EditorView as Editor } from '@codemirror/view';
import { createEditor } from './codeMirror';
const props=defineProps<{ modelValue:string; readOnly:boolean }>();
const emit=defineEmits<{ 'update:modelValue':[value:string] }>();
const host=ref<HTMLElement>(); let view:Editor|undefined; let applying=false;
function livePreview(state:EditorState):DecorationSet{
 const decorations:Range<Decoration>[]=[];
 syntaxTree(state).iterate({from:0,to:state.doc.length,enter(node){
  if(node.name.startsWith('ATXHeading')){const line=state.doc.lineAt(node.from);decorations.push(Decoration.line({class:`cm-md-heading cm-md-h${node.name.slice(-1)}`}).range(line.from))}
  else if(node.name==='StrongEmphasis')decorations.push(Decoration.mark({class:'cm-md-strong'}).range(node.from,node.to));
  else if(node.name==='Emphasis')decorations.push(Decoration.mark({class:'cm-md-em'}).range(node.from,node.to));
  else if(node.name==='Link')decorations.push(Decoration.mark({class:'cm-md-link'}).range(node.from,node.to));
  else if(node.name==='TaskMarker')decorations.push(Decoration.mark({class:'cm-md-task'}).range(node.from,node.to));
 }});
 return Decoration.set(decorations,true);
}
const preview=EditorView.decorations.compute(['doc'],state=>livePreview(state));
onMounted(()=>{if(host.value)view=createEditor(host.value,props.modelValue,props.readOnly,true,value=>{if(!applying)emit('update:modelValue',value)},[preview,EditorView.theme({'.cm-md-heading':{fontFamily:'var(--font-display, Georgia, serif)',fontWeight:'700'},'.cm-md-h1':{fontSize:'2.1rem',lineHeight:'1.3'},'.cm-md-h2':{fontSize:'1.45rem',lineHeight:'1.4'},'.cm-md-h3':{fontSize:'1.2rem'},'.cm-md-strong':{fontWeight:'700'},'.cm-md-em':{fontStyle:'italic'},'.cm-md-link':{color:'var(--nx-accent, #3a7fa0)',textDecoration:'underline'},'.cm-md-task':{color:'var(--nx-accent, #3a7fa0)'}})])});
watch(()=>props.modelValue,value=>{if(!view||view.state.doc.toString()===value)return;applying=true;const anchor=Math.min(view.state.selection.main.anchor,value.length);view.dispatch({changes:{from:0,to:view.state.doc.length,insert:value},selection:{anchor}});applying=false});
onBeforeUnmount(()=>view?.destroy());
</script>
<style scoped>
.markdown-wrap{position:relative;min-height:420px}.editing-area{min-height:420px}.block-gutter{position:absolute;left:-54px;top:7px;z-index:2;display:flex;opacity:0;transition:opacity .15s}.markdown-wrap:hover .block-gutter{opacity:1}.block-gutter button{width:24px;height:24px;border:0;border-radius:5px;background:transparent;color:var(--nx-text-tertiary,#8a96a6);font-size:14px}.block-gutter button:hover{background:var(--nx-bg-subtle,#f4f7fb)}
</style>
