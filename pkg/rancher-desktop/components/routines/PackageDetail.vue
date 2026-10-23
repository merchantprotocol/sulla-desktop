<template>
  <div class="detail">
    <button class="back" @click="$emit('close')">‹&nbsp; All use cases</button>
    <section class="hero card">
      <span class="glyph xl">{{ row.icon }}</span>
      <div class="hero-copy"><h1>{{ row.title }}</h1><p>{{ row.line }}</p><div class="meta">By <b>{{ row.publisher }}</b><span>Version {{ row.version }}</span><span v-if="row.updatedAt">Updated {{ updatedLabel }}</span><span v-if="downloadCount">{{ compact(downloadCount) }} people use it</span></div><div v-if="row.dashboardPort" class="badge">▣ <b>Includes a dashboard</b><code>opens at localhost:{{ row.dashboardPort }}</code></div></div>
      <div class="cta"><button v-if="installed" class="btn" @click="$emit('open-library')">Open My Library</button><button v-else class="btn primary" :disabled="busy" @click="$emit('get')">⇩&nbsp; {{ busy ? 'Getting…' : 'Get' }}</button><small v-if="!installed">Free · {{ sizeLabel }}</small></div>
    </section>
    <div class="layout">
      <div>
        <section class="card section"><h2>What it does</h2><!-- eslint-disable-next-line vue/no-v-html -- sanitized with DOMPurify -->
        <div v-if="descriptionHtml" class="md" v-html="descriptionHtml" /><p v-else>{{ row.line }}</p><div v-if="outcomes.length" class="outcomes"><div v-for="item in outcomes" :key="item.title"><b>{{ item.title }}</b><span>{{ item.note }}</span></div></div><div v-if="safetyNote" class="note"><b>What it doesn’t do.</b> {{ safetyNote }}</div></section>
        <section v-if="steps.length" class="card section"><h2>How it works</h2><ol class="steps"><li v-for="step in steps" :key="step.title || step.text"><span>{{ step.title }}</span>{{ step.text }}</li></ol></section>
        <section class="card section parts"><h2>What’s included</h2><div v-for="group in groups" :key="group.kind" class="group"><h3>{{ group.label }} <small>{{ group.items.length }}</small></h3><div v-for="item in group.items" :key="item.slug" class="part"><span class="glyph">{{ glyph(group.kind) }}</span><div><b>{{ item.name || item.slug }}</b><small>{{ item.slug }}<template v-if="item.version"> · v{{ item.version }}</template></small></div></div></div><div v-if="hasRecipe" class="note"><b>The recipe runs on Sulla Desktop only.</b> Its containers start on this computer. Agents and workflows remain available anywhere they’re supported.</div></section>
      </div>
      <aside class="card side">
        <div class="side-title"><span class="glyph">{{ row.icon }}</span><div><b>{{ row.name }}</b><small>{{ includesSummary }}</small></div></div>
        <dl><div><dt>Version</dt><dd>{{ row.version }}</dd></div><div><dt>Publisher</dt><dd>{{ row.publisher }}</dd></div><div><dt>Topic</dt><dd>{{ topic }}</dd></div><div><dt>Size</dt><dd>{{ sizeLabel }}</dd></div><div><dt>Runs on</dt><dd>{{ row.where === 'desktop' ? 'Desktop only' : 'Desktop + Cloud' }}</dd></div><div v-if="row.dashboardPort"><dt>Dashboard</dt><dd><code>localhost:{{ row.dashboardPort }}</code></dd></div><div><dt>Your data</dt><dd>Stays on this Desktop</dd></div></dl>
        <div class="side-action"><button v-if="installed" class="btn" @click="$emit('open-library')">Open My Library</button><button v-else class="btn primary" :disabled="busy" @click="$emit('get')">⇩&nbsp; {{ busy ? 'Getting…' : 'Get' }}</button></div>
      </aside>
    </div>
  </div>
</template>
<script setup lang="ts">
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { computed } from 'vue';
import { packageTopicLabel } from '@pkg/composables/packageTopics';
import type { PackageDetail } from '@pkg/composables/usePackages';
const props = defineProps<{ detail: PackageDetail; installed: boolean; busy: boolean }>();
defineEmits<{ (e:'close'):void; (e:'get'):void; (e:'open-library'):void }>();
const row = computed(() => props.detail.row);
const manifest = computed<any>(() => props.detail.manifest ?? {});
const page = computed<any>(() => manifest.value.page ?? {});
const descriptionHtml = computed(() => DOMPurify.sanitize(marked.parse(props.detail.descriptionMd || page.value.story_md || page.value.storyMd || '', { async:false })));
const outcomes = computed(() => Array.isArray(page.value.benefits) ? page.value.benefits.slice(0,3).map((x:any) => ({ title:String(x.title ?? ''), note:String(x.note ?? x.text ?? '') })) : []);
const steps = computed(() => Array.isArray(page.value.steps) ? page.value.steps.map((x:any) => typeof x === 'string' ? { title:'', text:x } : { title:String(x.title ?? ''), text:String(x.text ?? '') }) : []);
const safetyNote = computed(() => String(page.value.safety_note ?? page.value.safetyNote ?? manifest.value.safety_note ?? ''));
const groups = computed(() => { const labels:Record<string,string>={agent:'Agents',skill:'Skills',routine:'Workflows',function:'Functions',integration:'Integrations',recipe:'Recipes'}; return Object.entries(labels).map(([kind,label]) => ({kind,label,items:props.detail.contents.filter(i=>i.kind===kind)})).filter(g=>g.items.length); });
const hasRecipe = computed(() => props.detail.contents.some(i => i.kind === 'recipe'));
const topic = computed(() => packageTopicLabel(row.value.topic) || row.value.topic || '—');
const updatedLabel = computed(() => { const d=new Date(row.value.updatedAt); return Number.isNaN(d.getTime()) ? row.value.updatedAt : d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); });
const downloadCount = computed(() => Number((props.detail.raw as any).download_count) || 0);
const sizeLabel = computed(() => { const n=row.value.bundleSize; if(!n)return 'Size unavailable'; return n<1048576?`${(n/1024).toFixed(0)} KB`:`${(n/1048576).toFixed(1)} MB`; });
const includesSummary = computed(() => groups.value.map(g=>`${g.items.length} ${g.label.toLowerCase()}`).join(' · '));
function compact(n:number){ return new Intl.NumberFormat(undefined,{notation:'compact'}).format(n); }
function glyph(kind:string){ return ({agent:'♙',skill:'☆',routine:'⌘',function:'ƒ',integration:'⌁',recipe:'◇'} as Record<string,string>)[kind] || '•'; }
</script>
<style scoped>
.detail{color:var(--uc-text)}.back{border:0;background:none;color:var(--uc-muted);padding:0 0 14px;cursor:pointer}.card{background:var(--uc-card);border:1px solid var(--uc-line);border-radius:11px;box-shadow:0 8px 24px #0000000b}.hero{display:flex;gap:18px;align-items:flex-start;padding:22px 24px;margin-bottom:16px}.glyph{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:color-mix(in srgb,var(--uc-accent) 12%,transparent);flex:none}.glyph.xl{width:56px;height:56px;border-radius:14px;font-size:24px}.hero-copy{flex:1}.hero h1{font-size:24px;margin:1px 0 5px}.hero p{margin:0 0 10px;color:var(--uc-muted);font-size:14px}.meta{display:flex;gap:14px;color:var(--uc-dim);font-size:11px}.meta b{color:var(--uc-text)}.badge{display:inline-flex;align-items:center;gap:7px;margin-top:14px;padding:7px 10px;border:1px solid color-mix(in srgb,var(--uc-accent) 35%,var(--uc-line));border-radius:8px;background:color-mix(in srgb,var(--uc-accent) 9%,transparent);color:var(--uc-accent);font-size:12px}.badge code{color:var(--uc-muted);font-size:10px}.cta{display:grid;gap:6px;text-align:center}.cta small{color:var(--uc-dim);font-size:10px}.btn{border:1px solid var(--uc-line);background:var(--uc-card);color:var(--uc-text);border-radius:8px;padding:8px 14px}.btn.primary{background:var(--uc-accent);border-color:var(--uc-accent);color:#fff}.layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}.section{padding:18px 22px;margin-bottom:16px}.section h2{margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--uc-dim)}.section p,.md{line-height:1.6}.outcomes{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}.outcomes>div{padding:11px;border:1px solid var(--uc-line);border-radius:9px}.outcomes b,.outcomes span{display:block}.outcomes span{font-size:11px;color:var(--uc-muted);margin-top:4px}.note{margin-top:12px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--uc-accent) 25%,var(--uc-line));background:color-mix(in srgb,var(--uc-accent) 7%,transparent);border-radius:9px;color:var(--uc-muted);font-size:11px}.note b{color:var(--uc-text)}.steps{margin:0;padding:0;list-style:none;counter-reset:s}.steps li{counter-increment:s;padding:8px 0 8px 34px;border-top:1px solid var(--uc-line);position:relative}.steps li:before{content:counter(s);position:absolute;left:0;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--uc-accent) 12%,transparent);color:var(--uc-accent);font-size:10px}.steps span{font-weight:600;margin-right:6px}.group h3{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--uc-dim);margin:15px 0 0;padding-bottom:5px;border-bottom:1px solid var(--uc-line)}.group h3 small{font-weight:400;margin-left:5px}.part{display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--uc-line)}.part b,.part small{display:block}.part b{font-weight:500}.part small{font-size:10px;color:var(--uc-dim)}.side{position:sticky;top:0}.side-title{display:flex;gap:10px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--uc-line)}.side-title b,.side-title small{display:block}.side-title small{color:var(--uc-dim);font-size:10px}dl{margin:0;padding:6px 16px}dl>div{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--uc-line)}dt{color:var(--uc-dim)}dd{margin:0;text-align:right}.side-action{padding:12px 16px 16px}.side-action .btn{width:100%}@media(max-width:900px){.layout{grid-template-columns:1fr}.side{position:static}.outcomes{grid-template-columns:1fr}}
</style>
