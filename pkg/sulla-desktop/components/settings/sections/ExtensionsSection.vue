<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import ConfigurationLoadState from '../ConfigurationLoadState.vue';
import PrefCard from '../PrefCard.vue';
import PrefRow from '../PrefRow.vue';
import PrefToggle from '../PrefToggle.vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { useDatabaseAvailableReload } from '@pkg/composables/useDatabaseAvailableReload';
import { useConfigurationLoad } from '@pkg/composables/useConfigurationLoad';

type HookName = 'before_tool_call'|'after_tool_call'|'before_model_call'|'after_model_response'|'on_user_message'|'on_memory_write'|'on_workflow_node_start'|'on_workflow_node_finish'|'on_agent_job_start'|'on_agent_job_finish';
interface ExtensionInfo { extensionId:string; name:string; description:string; publisher:string; version:string|null; hooks:HookName[]; grants:Partial<Record<HookName,boolean>>; ui:Array<{slot:string;label:string}>; integration?:{id:string;version:string;permissions:string[];granted:boolean} }
interface AuditEvent { extensionId:string; hook:HookName; outcome:'ok'|'denied'|'error'|'timeout'|'permission_denied'; durationMs:number; timestamp:number; detail?:string }
const copy:Record<HookName,{title:string;kind:string}> = {
  on_user_message:{title:'Read your messages',kind:'Sees only'}, after_model_response:{title:'Read Sulla’s replies',kind:'Sees only'},
  after_tool_call:{title:'See tool results',kind:'Sees only'}, on_memory_write:{title:'See what Sulla saves to memory',kind:'Sees only'},
  on_workflow_node_start:{title:'See workflow steps start',kind:'Sees only'}, on_workflow_node_finish:{title:'See workflow steps finish',kind:'Sees only'},
  on_agent_job_start:{title:'See agents start',kind:'Sees only'}, on_agent_job_finish:{title:'See agents finish',kind:'Sees only'},
  before_tool_call:{title:'Check tool calls before they run',kind:'Can change or stop'}, before_model_call:{title:'Check what Sulla sends to the AI model',kind:'Can change or stop'},
};
const extensions=ref<ExtensionInfo[]>([]); const audit=ref<AuditEvent[]>([]); const problems=ref(false); const busy=ref(false); const error=ref('');
const permissionsReady=ref(false);
const pendingHint=computed(()=>permissionsLoadError.value ? 'Permissions unavailable' : 'Loading permissions…');
const activity=computed(()=>audit.value.filter(e=>!problems.value||e.outcome!=='ok').slice().sort((a,b)=>b.timestamp-a.timestamp));
const names=computed(()=>Object.fromEntries(extensions.value.map(e=>[e.extensionId,e.name])));
// Paints the installed list from disk. Skipped once the DB list has landed, so it never overwrites grants.
async function loadLocal(){ try { const local=await ipcRenderer.invoke('extension-permissions:local'); if(!permissionsReady.value) extensions.value=local; } catch(e){ error.value=String(e) } }
const { error: permissionsLoadError, start: loadPermissions } = useConfigurationLoad(async() => {
  permissionsReady.value = false;
  const rows = await ipcRenderer.invoke('extension-permissions:list');
  if (!rows) return false;
  extensions.value = rows;
  permissionsReady.value = true;
  void loadAudit();
});
// Audit is independent: it never blocks the installed list.
async function loadAudit(){ try { audit.value=await ipcRenderer.invoke('extension-permissions:audit') } catch(e){ error.value=String(e) } }
async function setHook(ext:ExtensionInfo,hook:HookName,granted:boolean){if(!permissionsReady.value)return;busy.value=true;try{await ipcRenderer.invoke('extension-permissions:set-hook',{extensionId:ext.extensionId,hook,granted});ext.grants[hook]=granted}catch(e){error.value=String(e)}finally{busy.value=false}}
// Readiness gates new edits only. An accepted write runs to completion even if a reload starts meanwhile.
async function writeIntegration(ext:ExtensionInfo,granted:boolean){if(!ext.integration)return;if(granted)await ipcRenderer.invoke('integration-grants:grant',{id:ext.integration.id,version:ext.integration.version,permissions:ext.integration.permissions});else await ipcRenderer.invoke('integration-grants:revoke',{id:ext.integration.id,version:ext.integration.version});ext.integration.granted=granted}
async function setIntegration(ext:ExtensionInfo,granted:boolean){if(!ext.integration||!permissionsReady.value)return;busy.value=true;try{await writeIntegration(ext,granted)}catch(e){error.value=String(e)}finally{busy.value=false}}
async function revoke(extensionId?:string){if(!permissionsReady.value)return;busy.value=true;const targets=extensions.value.filter(ext=>!extensionId||ext.extensionId===extensionId);try{await ipcRenderer.invoke('extension-permissions:revoke-all',extensionId);for(const ext of targets){ext.grants={};if(ext.integration?.granted)try{await writeIntegration(ext,false)}catch(e){error.value=String(e)}}}catch(e){error.value=String(e)}finally{busy.value=false}}
function result(e:AuditEvent){return e.outcome==='ok'?'Allowed':e.outcome==='permission_denied'||e.outcome==='denied'?'Denied':e.outcome==='timeout'?'Timed out':'Failed'}
function time(ts:number){return new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(ts)}
useDatabaseAvailableReload(loadPermissions,'ExtensionsSection');
onMounted(()=>{ void loadLocal(); void loadPermissions(); });
</script>
<template><div>
  <div class="ph"><div><h1>Extensions</h1><p>What each extension can see and change. Turn anything off at any time.</p></div><div class="r"><button class="btn danger" type="button" :disabled="busy || !permissionsReady" @click="revoke()">Revoke all</button></div></div>
  <p v-if="error" class="note badc">{{error}}</p>
  <ConfigurationLoadState v-if="!permissionsReady" label="Loading extension permissions…" :error="permissionsLoadError ? 'Couldn’t load extension permissions.' : ''" @retry="loadPermissions" />
  <PrefCard v-else-if="!extensions.length" title="Installed extensions" subtitle="Extensions with hooks or interface permissions appear here."><p class="note">No extension permissions to show.</p></PrefCard>
  <PrefCard v-for="ext in extensions" :key="ext.extensionId" :title="ext.name" :subtitle="`${ext.publisher}${ext.version ? ` · ${ext.version}` : ''}`">
    <template #actions><span v-if="!permissionsReady" class="note">{{ pendingHint }}</span><button v-else-if="ext.hooks.some(h=>ext.grants[h]) || ext.integration?.granted" class="btn danger" type="button" :disabled="busy" @click="revoke(ext.extensionId)">Revoke all</button><span v-else class="note">Everything off</span></template>
    <PrefRow v-for="hook in ext.hooks" :key="hook" :title="copy[hook].title" :subtitle="`${copy[hook].kind} · ${hook}`" :off="permissionsReady && !ext.grants[hook]"><PrefToggle :model-value="!!ext.grants[hook]" :disabled="busy || !permissionsReady" :label="copy[hook].title" @update:model-value="setHook(ext,hook,$event)"/><span v-if="!permissionsReady" class="note pending">{{ pendingHint }}</span></PrefRow>
    <PrefRow v-if="ext.integration" :title="`${ext.name} connection`" :subtitle="ext.integration.permissions.join(', ')" :off="permissionsReady && !ext.integration.granted"><PrefToggle :model-value="!!ext.integration.granted" :disabled="busy || !permissionsReady" :label="`${ext.name} connection`" @update:model-value="setIntegration(ext,$event)"/><span v-if="!permissionsReady" class="note pending">{{ pendingHint }}</span></PrefRow>
    <PrefRow v-for="item in ext.ui" :key="item.slot" :title="item.label" :subtitle="item.slot"><span class="note">Added by the extension</span></PrefRow>
    <PrefRow title="Never gets passwords, API keys or tokens." />
  </PrefCard>
  <PrefCard title="Recent activity" subtitle="Last 500 events. Sulla logs what ran, never what was in it.">
    <template #actions><div class="seg"><button type="button" :class="{on:!problems}" @click="problems=false">All</button><button type="button" :class="{on:problems}" @click="problems=true">Problems</button></div></template>
    <PrefRow v-for="event in activity" :key="`${event.timestamp}-${event.extensionId}-${event.hook}`" :title="copy[event.hook]?.title || event.hook" :subtitle="event.detail"><template #label><b>{{copy[event.hook]?.title || event.hook}}</b><small>{{names[event.extensionId]||event.extensionId}} · {{time(event.timestamp)}}</small></template><span :class="['audit-result',event.outcome]">{{result(event)}} · {{event.durationMs}} ms</span></PrefRow>
    <p v-if="!activity.length" class="note">No activity yet.</p>
  </PrefCard>
</div></template>
<style scoped>.danger{color:var(--danger)}.seg{display:flex;gap:2px}.seg button{border:0;background:transparent;color:var(--text-muted);padding:5px 10px;border-radius:6px}.seg button.on{background:var(--surface-3);color:var(--text)}.audit-result{font-size:12px}.audit-result.ok{color:var(--success)}.audit-result.timeout{color:var(--warning)}.audit-result.error,.audit-result.denied,.audit-result.permission_denied{color:var(--danger)}.pending{margin-left:8px}</style>
