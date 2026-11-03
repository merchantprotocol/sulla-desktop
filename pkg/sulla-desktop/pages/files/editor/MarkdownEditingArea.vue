<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div ref="wrap" class="markdown-wrap" @pointerdown.capture="rememberSelection" @mousemove="trackLine" @contextmenu="openContextMenu" @mouseleave="gutterVisible=false">
    <div v-if="!readOnly" class="block-gutter" :class="{ visible:gutterVisible }" :style="{top:`${gutterTop}px`}"><button type="button" aria-label="Insert block on this line" @mousedown.prevent @click="openGutterMenu">＋</button></div>
    <div ref="host" class="editing-area" />
  </div>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { EditorView as Editor } from '@codemirror/view';
import { textPatch, createEditor, type EditorCollaboration } from './codeMirror';
const props=defineProps<{ modelValue:string; readOnly:boolean; live?:EditorCollaboration|null }>();
const emit=defineEmits<{ 'update:modelValue':[value:string]; insertMenu:[point:{x:number;y:number}] }>();
const wrap=ref<HTMLElement>(),gutterVisible=ref(false),gutterTop=ref(4);let gutterLine=0,contextHadSelection=false;
const host=ref<HTMLElement>(); let view:Editor|undefined; let applying=false;
class ImageWidget extends WidgetType { constructor(private readonly src:string,private readonly alt:string){super()} toDOM(){const image=document.createElement('img');image.src=this.src;image.alt=this.alt;image.className='cm-md-image';image.loading='lazy';return image} eq(other:ImageWidget){return other.src===this.src&&other.alt===this.alt} }
class BulletWidget extends WidgetType { toDOM(){const dot=document.createElement('span');dot.className='cm-md-bullet';dot.textContent='•';return dot} }
class RuleWidget extends WidgetType { toDOM(){const rule=document.createElement('hr');rule.className='cm-md-rule';return rule} }
class TaskWidget extends WidgetType {
 constructor(private readonly checked:boolean,private readonly markerFrom:number,private readonly disabled:boolean){super()}
 eq(other:TaskWidget){return other.checked===this.checked&&other.markerFrom===this.markerFrom&&other.disabled===this.disabled}
 toDOM(editor:EditorView){const button=document.createElement('button');button.type='button';button.className=`cm-md-checkbox${this.checked?' checked':''}`;button.setAttribute('aria-label',this.checked?'Mark task incomplete':'Mark task complete');button.setAttribute('aria-checked',String(this.checked));button.textContent=this.checked?'✓':'';button.disabled=this.disabled;button.addEventListener('mousedown',event=>event.preventDefault());button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(this.disabled)return;const current=editor.state.doc.sliceString(this.markerFrom,this.markerFrom+3);if(!/^\[[ xX]\]$/.test(current))return;editor.dispatch({changes:{from:this.markerFrom+1,to:this.markerFrom+2,insert:/[xX]/.test(current)?' ':'x'}});editor.focus()});return button}
 ignoreEvent(){return false}
}
function plainInline(source:string){return source.replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/(`+|\*\*|__|~~|\*|_)/g,'').trim()}
class TableWidget extends WidgetType {
 constructor(private readonly source:string,private readonly from:number){super()}
 eq(other:TableWidget){return other.source===this.source&&other.from===this.from}
 toDOM(editor:EditorView){const shell=document.createElement('div');shell.className='cm-md-table-shell';shell.title='Click to edit table source';const rows=this.source.split(/\r?\n/).filter(Boolean).map(line=>line.trim().replace(/^\||\|$/g,'').split('|').map(cell=>plainInline(cell.trim())));const body=rows.filter((_,index)=>index!==1);const table=document.createElement('table');body.forEach((cells,rowIndex)=>{const row=document.createElement('tr');cells.forEach(value=>{const cell=document.createElement(rowIndex===0?'th':'td');cell.textContent=value;row.appendChild(cell)});table.appendChild(row)});shell.appendChild(table);shell.addEventListener('click',()=>{editor.dispatch({selection:{anchor:this.from},scrollIntoView:true});editor.focus()});return shell}
 ignoreEvent(){return false}
}
function selectionTouchesLine(state:EditorState,from:number,to:number){return state.selection.ranges.some(range=>range.from<=to&&range.to>=from)}
function hidden(decorations:Range<Decoration>[],from:number,to:number){if(to>from)decorations.push(Decoration.replace({}).range(from,to))}
function blockPreviewDecorations(state:EditorState):DecorationSet{
 const decorations:Range<Decoration>[]=[],tree=syntaxTree(state),tableSpans:{from:number;to:number}[]=[];
 const frontMatterEnd=(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(state.doc.toString())?.[0].length)??0;
 tree.iterate({enter(node){
  if(node.name!=='Table'&&node.name!=='HorizontalRule')return;
  // The front-matter fences parse as rules; they belong to the properties block, not the document.
  if(node.from<frontMatterEnd)return false;
  const startLine=state.doc.lineAt(node.from),endLine=state.doc.lineAt(Math.max(node.from,node.to-1));
  if(node.name==='Table')tableSpans.push({from:node.from,to:node.to});
  if(selectionTouchesLine(state,startLine.from,endLine.to))return;
  if(node.name==='Table'){
   decorations.push(Decoration.replace({widget:new TableWidget(state.doc.sliceString(node.from,node.to),node.from),block:true}).range(startLine.from,endLine.to));
   return false
  }
  decorations.push(Decoration.replace({widget:new RuleWidget(),block:true}).range(startLine.from,startLine.to))
 }});
 const text=state.doc.toString(),imagePattern=/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g;let match:RegExpExecArray|null;
 while((match=imagePattern.exec(text))){const from=match.index,to=from+match[0].length;if(tableSpans.some(table=>from>=table.from&&from<table.to))continue;const line=state.doc.lineAt(from);if(!selectionTouchesLine(state,line.from,line.to))decorations.push(Decoration.replace({widget:new ImageWidget(match[2],match[1]),block:true}).range(from,to))}
 const frontMatter=/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);if(frontMatter&&state.selection.main.head>frontMatter[0].length)decorations.push(Decoration.replace({block:true}).range(0,frontMatter[0].length-(frontMatter[0].endsWith('\n')?1:0)));
 return Decoration.set(decorations,true)
}
const blockPreview=StateField.define<DecorationSet>({
 create:state=>blockPreviewDecorations(state),
 update(value,transaction){return transaction.docChanged||!transaction.startState.selection.eq(transaction.state.selection)||syntaxTree(transaction.startState)!==syntaxTree(transaction.state)?blockPreviewDecorations(transaction.state):value},
 provide:field=>EditorView.decorations.from(field),
});
function previewDecorations(editor:EditorView):DecorationSet{
 const state=editor.state,decorations:Range<Decoration>[]=[],tree=syntaxTree(state),seenLines=new Set<number>();
 const ranges=editor.visibleRanges.map(range=>({from:state.doc.lineAt(range.from).from,to:state.doc.lineAt(range.to).to}));
 for(const range of ranges){
  for(let pos=range.from;pos<=range.to;){const line=state.doc.lineAt(pos);if(!seenLines.has(line.from)){seenLines.add(line.from);const active=selectionTouchesLine(state,line.from,line.to);const task=/^(\s*)([-+*])\s+(\[[ xX]\])\s+/.exec(line.text);if(task){const prefix=line.from+task[1].length,markerFrom=prefix+task[2].length+1;decorations.push(Decoration.replace({widget:new TaskWidget(/[xX]/.test(task[3]),markerFrom,props.readOnly)}).range(prefix,markerFrom+3));if(/[xX]/.test(task[3]))decorations.push(Decoration.line({class:'cm-md-task-done'}).range(line.from))}else if(!active){const bullet=/^(\s*)([-+*])(?=\s+)/.exec(line.text);if(bullet){const from=line.from+bullet[1].length;decorations.push(Decoration.replace({widget:new BulletWidget()}).range(from,from+1))}const ordered=/^(\s*)(\d+[.)])(?=\s+)/.exec(line.text);if(ordered){const from=line.from+ordered[1].length;decorations.push(Decoration.mark({class:'cm-md-list-number'}).range(from,from+ordered[2].length))}}}if(line.to>=range.to)break;pos=line.to+1}
  tree.iterate({from:range.from,to:range.to,enter(node){
   const startLine=state.doc.lineAt(node.from),endLine=state.doc.lineAt(Math.max(node.from,node.to-1)),active=selectionTouchesLine(state,startLine.from,endLine.to),source=state.doc.sliceString(node.from,node.to);
   if(node.name.startsWith('ATXHeading')){decorations.push(Decoration.line({class:`cm-md-heading cm-md-h${node.name.slice(-1)}`}).range(startLine.from));if(!active){const mark=/^#{1,6}[ \t]+/.exec(source);if(mark)hidden(decorations,node.from,node.from+mark[0].length)}}
   else if(node.name==='StrongEmphasis')decorations.push(Decoration.mark({class:'cm-md-strong'}).range(node.from,node.to));
   else if(node.name==='Emphasis')decorations.push(Decoration.mark({class:'cm-md-em'}).range(node.from,node.to));
   else if(node.name==='Strikethrough')decorations.push(Decoration.mark({class:'cm-md-strike'}).range(node.from,node.to));
   else if(node.name==='InlineCode')decorations.push(Decoration.mark({class:'cm-md-code'}).range(node.from,node.to));
   else if((node.name==='EmphasisMark'||node.name==='StrikethroughMark'||node.name==='CodeMark')&&!active)hidden(decorations,node.from,node.to);
   else if(node.name==='Link'&&!source.startsWith('![')){decorations.push(Decoration.mark({class:'cm-md-link'}).range(node.from,node.to));if(!active){const match=/^\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)$/.exec(source);if(match){hidden(decorations,node.from,node.from+1);const close=node.from+1+match[1].length;hidden(decorations,close,node.to)}}}
   else if(node.name==='Blockquote'){for(let n=startLine.number;n<=endLine.number;n++)decorations.push(Decoration.line({class:'cm-md-quote'}).range(state.doc.line(n).from))}
   else if(node.name==='QuoteMark'&&!active)hidden(decorations,node.from,Math.min(node.to+(state.doc.sliceString(node.to,node.to+1)===' '?1:0),startLine.to));
   else if(node.name==='Table'||node.name==='HorizontalRule')return false;
   else if(node.name==='FencedCode'){for(let n=startLine.number;n<=endLine.number;n++)decorations.push(Decoration.line({class:'cm-md-code-block'}).range(state.doc.line(n).from));if(!active){hidden(decorations,startLine.from,startLine.to);if(endLine.number>startLine.number)hidden(decorations,endLine.from,endLine.to)}return false}
  }});
 }
 return Decoration.set(decorations,true)
}
const preview=ViewPlugin.fromClass(class {decorations:DecorationSet;constructor(editor:EditorView){this.decorations=previewDecorations(editor)}update(update:ViewUpdate){if(update.docChanged||update.selectionSet||update.viewportChanged||update.geometryChanged)this.decorations=previewDecorations(update.view)}},{decorations:value=>value.decorations});
function build(){view?.destroy();view=undefined;if(host.value)view=createEditor(host.value,props.modelValue,props.readOnly,true,value=>{if(!applying)emit('update:modelValue',value)},[blockPreview,preview,EditorView.domEventHandlers({click(event,editor){if(!(event.metaKey||event.ctrlKey))return false;const pos=editor.posAtCoords({x:event.clientX,y:event.clientY});if(pos===null)return false;let node=syntaxTree(editor.state).resolveInner(pos,-1);while(node&&node.name!=='Link')node=node.parent;if(!node)return false;const match=/\]\((https?:\/\/[^\s)]+)/.exec(editor.state.doc.sliceString(node.from,node.to));if(!match)return false;window.open(match[1],'_blank','noopener,noreferrer');event.preventDefault();return true}}),EditorView.theme({'.cm-md-heading':{fontFamily:'var(--font-body)',fontWeight:'700'},'.cm-md-h1':{fontSize:'2.1rem',lineHeight:'1.3'},'.cm-md-h2':{fontSize:'1.65rem',lineHeight:'1.35'},'.cm-md-h3':{fontSize:'1.3rem'},'.cm-md-h4':{fontSize:'1.12rem'},'.cm-md-h5':{fontSize:'1rem'},'.cm-md-h6':{fontSize:'.92rem',color:'var(--text-muted)'},'.cm-md-strong':{fontWeight:'700'},'.cm-md-em':{fontStyle:'italic'},'.cm-md-strike,.cm-md-task-done':{textDecoration:'line-through',color:'var(--text-muted)'},'.cm-md-link':{color:'var(--accent)',textDecoration:'underline',cursor:'pointer'},'.cm-md-code':{fontFamily:'var(--font-mono)',fontSize:'.9em',background:'var(--bg-surface-alt, rgba(58,127,160,.1))',borderRadius:'4px',padding:'1px 4px'},'.cm-md-quote':{borderLeft:'3px solid var(--accent)',paddingLeft:'14px',color:'var(--text-muted)'},'.cm-md-list-number':{color:'var(--text-muted)'},'.cm-md-code-block':{fontFamily:'var(--font-mono)',fontSize:'.9em',background:'var(--bg-surface-alt, rgba(58,127,160,.08))'},'.cm-md-bullet':{display:'inline-block',width:'1ch',color:'var(--accent)',fontWeight:'700'},'.cm-md-checkbox':{display:'inline-flex',alignItems:'center',justifyContent:'center',width:'18px',height:'18px',margin:'0 8px 0 1px',padding:'0',border:'2px solid var(--accent)',borderRadius:'50%',background:'transparent',color:'#fff',fontSize:'12px',lineHeight:'1',verticalAlign:'-2px',cursor:'pointer'},'.cm-md-checkbox.checked':{background:'var(--accent)'},'.cm-md-checkbox:disabled':{cursor:'default'},'.cm-md-rule':{width:'100%',border:'0',borderTop:'1px solid var(--border-default)',margin:'14px 0'},'.cm-md-table-shell':{overflowX:'auto',margin:'10px 0',cursor:'text'},'.cm-md-table-shell table':{width:'100%',borderCollapse:'collapse'},'.cm-md-table-shell th,.cm-md-table-shell td':{padding:'8px 10px',border:'1px solid var(--border-default)',textAlign:'left'},'.cm-md-table-shell th':{fontWeight:'700',background:'var(--bg-surface-alt, rgba(58,127,160,.08))'},'.cm-md-image':{display:'block',maxWidth:'100%',maxHeight:'520px',margin:'14px 0',borderRadius:'10px'}})],props.live);}
onMounted(build);
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
