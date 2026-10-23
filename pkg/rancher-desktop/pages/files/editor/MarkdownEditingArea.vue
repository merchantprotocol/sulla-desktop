<template>
  <div ref="wrap" class="markdown-wrap" @pointerdown.capture="rememberSelection" @mousemove="trackLine" @contextmenu="openContextMenu" @mouseleave="gutterVisible=false">
    <div v-if="!readOnly" class="block-gutter" :class="{ visible:gutterVisible }" :style="{top:`${gutterTop}px`}"><button type="button" aria-label="Insert block on this line" @mousedown.prevent @click="openGutterMenu">＋</button></div>
    <div ref="host" class="editing-area" />
  </div>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { EditorView as Editor } from '@codemirror/view';
import { textPatch, createEditor, type EditorCollaboration } from './codeMirror';
const props=defineProps<{ modelValue:string; readOnly:boolean; live?:EditorCollaboration|null }>();
const emit=defineEmits<{ 'update:modelValue':[value:string]; insertMenu:[point:{x:number;y:number}] }>();
const wrap=ref<HTMLElement>(),gutterVisible=ref(false),gutterTop=ref(4);let gutterLine=0,contextHadSelection=false;
const host=ref<HTMLElement>(); let view:Editor|undefined; let applying=false;
class ImageWidget extends WidgetType { constructor(private readonly src:string,private readonly alt:string){super()} toDOM(){const image=document.createElement('img');image.src=this.src;image.alt=this.alt;image.className='cm-md-image';image.loading='lazy';return image} eq(other:ImageWidget){return other.src===this.src&&other.alt===this.alt} }
function livePreview(state:EditorState):DecorationSet{
 const decorations:Range<Decoration>[]=[];
 syntaxTree(state).iterate({from:0,to:state.doc.length,enter(node){
  if(node.name.startsWith('ATXHeading')){const line=state.doc.lineAt(node.from);decorations.push(Decoration.line({class:`cm-md-heading cm-md-h${node.name.slice(-1)}`}).range(line.from))}
  else if(node.name==='StrongEmphasis')decorations.push(Decoration.mark({class:'cm-md-strong'}).range(node.from,node.to));
  else if(node.name==='Emphasis')decorations.push(Decoration.mark({class:'cm-md-em'}).range(node.from,node.to));
  else if(node.name==='Link'&&!state.doc.sliceString(node.from,node.to).startsWith('!['))decorations.push(Decoration.mark({class:'cm-md-link'}).range(node.from,node.to));
  else if(node.name==='TaskMarker')decorations.push(Decoration.mark({class:'cm-md-task'}).range(node.from,node.to));
 }});
 const source=state.doc.toString();
 // Front matter is shown as property pills; the raw YAML only appears while the cursor is inside it.
 const frontMatter=/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source);
 if(frontMatter){const cursor=state.selection.main.head;if(cursor>frontMatter[0].length)decorations.push(Decoration.replace({block:true}).range(0,frontMatter[0].length-(frontMatter[0].endsWith('\n')?1:0)))}
 const imagePattern=/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g;let match:RegExpExecArray|null;
 while((match=imagePattern.exec(source))){const from=match.index,to=from+match[0].length;const line=state.doc.lineAt(from);const cursor=state.selection.main.head;if(cursor<line.from||cursor>line.to)decorations.push(Decoration.replace({widget:new ImageWidget(match[2],match[1]),block:true}).range(from,to))}
 return Decoration.set(decorations,true);
}
const preview=EditorView.decorations.compute(['doc','selection'],state=>livePreview(state));
function build(){view?.destroy();view=undefined;if(host.value)view=createEditor(host.value,props.modelValue,props.readOnly,true,value=>{if(!applying)emit('update:modelValue',value)},[preview,EditorView.theme({'.cm-md-heading':{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif',fontWeight:'700'},'.cm-md-h1':{fontSize:'2.1rem',lineHeight:'1.3'},'.cm-md-h2':{fontSize:'22px',lineHeight:'1.4'},'.cm-md-h3':{fontSize:'1.2rem'},'.cm-md-strong':{fontWeight:'700'},'.cm-md-em':{fontStyle:'italic'},'.cm-md-link':{color:'#3a7fa0',textDecoration:'underline'},'.cm-md-task':{color:'#3a7fa0'},'.cm-md-image':{display:'block',maxWidth:'100%',maxHeight:'520px',margin:'14px 0',borderRadius:'10px'}})],props.live);}
onMounted(build);
// Live editing arrives after the file loads; rebind CodeMirror to the Automerge-backed Y.Text.
watch(()=>props.live,()=>{build();startAfterFrontMatter();});
watch(()=>props.modelValue,value=>{if(!view||view.state.doc.toString()===value)return;applying=true;view.dispatch({changes:textPatch(view.state.doc.toString(),value)});applying=false});
function startAfterFrontMatter(){if(!view)return;const match=/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(view.state.doc.toString());if(match)view.dispatch({selection:{anchor:Math.min(match[0].length+1,view.state.doc.length)}})}
onMounted(startAfterFrontMatter);
function revealProperties(){if(!view)return;view.focus();view.dispatch({selection:{anchor:Math.min(4,view.state.doc.length)},scrollIntoView:true})}
function trackLine(event:MouseEvent){if(!view||!wrap.value||props.readOnly)return;const rect=wrap.value.getBoundingClientRect();const block=view.lineBlockAtHeight(event.clientY-view.documentTop);gutterLine=view.state.doc.lineAt(block.from).from;gutterTop.value=view.documentTop+block.top-rect.top+4;gutterVisible.value=true}
function rememberSelection(event:PointerEvent){if(event.button===2)contextHadSelection=!!view&&!view.state.selection.main.empty}
function openContextMenu(event:MouseEvent){if(!view||props.readOnly||contextHadSelection||!view.state.selection.main.empty)return;const pos=view.posAtCoords({x:event.clientX,y:event.clientY});if(pos===null)return;event.preventDefault();view.dispatch({selection:{anchor:pos}});emit('insertMenu',{x:event.clientX,y:event.clientY})}
function openGutterMenu(event:MouseEvent){if(!view||props.readOnly)return;view.dispatch({selection:{anchor:gutterLine}});const rect=(event.currentTarget as HTMLElement).getBoundingClientRect();emit('insertMenu',{x:rect.right+6,y:rect.top})}
function insertBlock(text:string){if(!view||props.readOnly)return;const line=view.state.doc.lineAt(view.state.selection.main.head);const empty=!line.text.trim();const from=empty?line.from:line.to;const insert=(empty?'':'\n')+text;view.dispatch({changes:{from,to:empty?line.to:from,insert},selection:{anchor:from+(empty?0:1)+Math.min(text.length,!text.includes('\n')?text.length:text.indexOf('\n'))},scrollIntoView:true});view.focus()}
function addProperty(){if(!view||props.readOnly)return;const source=view.state.doc.toString(),match=/^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.exec(source);const eol=source.startsWith('---\r\n')?'\r\n':'\n';let from=0,insert='',keyStart=0;if(match){const close=match[0].lastIndexOf(eol+'---');from=close+eol.length;insert=`property: value${eol}`;keyStart=from}else{insert='---\nproperty: value\n---\n';keyStart=4}view.dispatch({changes:{from,insert},selection:{anchor:keyStart,head:keyStart+8},scrollIntoView:true});view.focus()}
defineExpose({revealProperties,insertBlock,addProperty});
onBeforeUnmount(()=>view?.destroy());
</script>
<style scoped>
.markdown-wrap{position:relative;min-height:420px;padding-left:52px;margin-left:-52px}.editing-area{min-height:420px}.block-gutter{position:absolute;left:0;z-index:2;display:flex;opacity:0;transition:opacity .15s}.block-gutter.visible,.block-gutter:focus-within{opacity:1}.block-gutter button{width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:#8a96a6;font-size:13px;cursor:pointer}.block-gutter button:hover{background:#f4f7fb}
</style>
