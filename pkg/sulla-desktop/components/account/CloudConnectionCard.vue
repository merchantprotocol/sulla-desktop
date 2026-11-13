<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template><div class="sync-card">
  <div v-if="status?.device?.revoked || status?.device?.error" class="alert">{{ status.device.error || 'This Desktop was removed from your Cloud account.' }}</div>
  <div class="master"><div><h2>Sync this Desktop to Sulla Cloud</h2><span v-if="status?.device?.teamName" class="destination">Syncing to {{ status.device.teamName }}</span><p>Signing in doesn't send anything to the cloud. When enabled, selected data is available in Sulla on your phone, the web and other computers. Turn anything below off to keep it on this Desktop only.</p><button v-if="!enabled" type="button" class="recommend" :disabled="busy" @click="enableRecommended">Turn on recommended</button></div><label class="switch"><input type="checkbox" :checked="enabled" :disabled="busy" @change="setPref('enabled', checked($event))"><span /></label></div>
  <div class="status"><b>{{ syncLine }}</b><span v-if="lastChange">Last change uploaded: {{ lastChange }}</span></div>
  <template v-for="group in groups" :key="group.title"><div class="section">{{ group.title }}</div><div v-for="item in group.items" :key="item.key" class="row">
    <span class="icon">{{ item.icon }}</span><div class="copy"><button v-if="item.link" type="button" class="link" @click="item.link()">{{ item.title }}</button><b v-else>{{ item.title }}</b><small>{{ item.detail }}</small></div><span :class="['privacy',item.private?'private':'account']">{{ item.privacy }}</span>
    <label class="switch"><input type="checkbox" :checked="!!status?.preferences?.[item.key]" :disabled="busy || (!enabled && item.key !== 'remoteAccess')" @change="toggleKind(item.key,checked($event),item.title)"><span /></label>
  </div></template>
  <!-- Approvals live on this Desktop, so they are managed here, not on the web. -->
  <div v-if="showDevices" class="devices">
    <div class="drow"><span>Secure channel</span><b :class="['pill', status?.channel?.state === 'connected' ? 'on' : 'off']">{{ channelLabel }}</b></div>
    <div v-if="status?.keyFingerprint" class="drow"><span>Device key</span><code>{{ status.keyFingerprint }}</code></div>
    <div v-for="c in status?.approvedClients ?? []" :key="c.clientId" class="drow">
      <span><b>{{ c.label }}</b><small>{{ c.surface === 'mobile' ? 'Phone' : 'Browser' }} · approved {{ fmt(c.approvedAt) }}<template v-if="c.lastUsedAt"> · last used {{ fmt(c.lastUsedAt) }}</template></small></span>
      <button type="button" class="btn danger" :disabled="busy" @click="revoke(c.clientId)">Revoke</button>
    </div>
    <p v-if="!status?.approvedClients?.length" class="note">No browsers or phones approved yet. A new one asks first, and you approve it here after checking the 6-digit code.</p>
    <button type="button" class="link" @click="openDesktopsPage">Open the Desktops page at sulladesktop.com ›</button>
  </div>
  <div class="footer"><button class="btn" :disabled="busy||!enabled" @click="syncNow">Sync now</button><span/><button class="btn danger" :disabled="busy" @click="deleteAll">Delete my data from Sulla Cloud…</button></div>
  <p v-if="error" class="error">{{ error }}</p>
  <p class="note">Turning a switch off stops new uploads and asks whether to keep or delete what's already in Cloud. End-to-end encrypted data can't be read by Sulla's servers. Recommended never includes passwords, API keys or remote access.</p>
</div></template>
<script setup lang="ts">
import { computed,onBeforeUnmount,onMounted,ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { useBrowserTabs } from '@pkg/composables/useBrowserTabs';
type Pref='enabled'|'usage'|'memory'|'conversations'|'files'|'vault'|'remoteAccess';
const status=ref<Record<string,any>|null>(null),busy=ref(false),error=ref('');const {tabs,createTab}=useBrowserTabs();
const enabled=computed(()=>!!status.value?.preferences?.enabled);
const objectStatuses=computed(()=>status.value?.objectSync??[]);
const latest=computed(()=>objectStatuses.value.filter((x:any)=>x.lastSyncAt).sort((a:any,b:any)=>b.lastSyncAt.localeCompare(a.lastSyncAt))[0]);
const syncLine=computed(()=>!enabled.value?'Sync is off':latest.value?`Synced ${fmt(latest.value.lastSyncAt)}`:'Ready to sync');
const lastChange=computed(()=>latest.value?.kind?titleFor(latest.value.kind):'');
function openFiles(){const existing=tabs.find(t=>t.mode==='files');const tab=existing??createTab('about:blank',{mode:'files',title:'File Manager'});window.dispatchEvent(new CustomEvent('sulla:navigate-tab',{detail:{tabId:tab.id}}))}
const showDevices=ref(false);
const channelLabel=computed(()=>({connected:'Connected',connecting:'Connecting…',error:status.value?.channel?.lastError?`Reconnecting — ${status.value.channel.lastError}`:'Reconnecting',stopped:'Off'} as Record<string,string>)[status.value?.channel?.state??'stopped']);
function revoke(clientId:string){return run(()=>ipcRenderer.invoke('sulla-cloud-connection:revoke-client',clientId))}
function openDesktopsPage(){void ipcRenderer.invoke('sulla-cloud-connection:open-devices-page').catch(()=>undefined)}
const groups=[
 {title:'Activity',items:[['usage','▮','Token usage','Tokens, cost and limits by day, provider and model']].map(row)},
 {title:'Private data',items:[privateRow('conversations','✉','Chat history','Your linked chat history','🔒 End-to-end encrypted'),privateRow('memory','⌘','Memory','What Sulla remembers about you and your business','🔒 End-to-end encrypted'),{...privateRow('files','▤','Files','Choose folders in File Manager','🔒 End-to-end encrypted'),link:openFiles},privateRow('vault','⚿','Passwords','Opens only with your master password','🔒 Zero-knowledge')]},
 {title:'Control',items:[{...row(['remoteAccess','⇄','Remote access','Let approved browsers and phones run tasks on this Desktop']),privacy:'Manage devices ›',link:()=>{showDevices.value=!showDevices.value}}]},
];
function row(x:string[]){return{key:x[0] as Pref,icon:x[1],title:x[2],detail:x[3],privacy:'Readable by your account',private:false,link:undefined as undefined|(()=>void)}}
function privateRow(key:Pref,icon:string,title:string,detail:string,privacy:string){return{key,icon,title,detail,privacy,private:true,link:undefined as undefined|(()=>void)}}
function checked(e:Event){return(e.target as HTMLInputElement).checked}function fmt(iso:string){return new Date(iso).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}function titleFor(k:string){return groups.flatMap(g=>g.items).find(i=>i.key===k)?.title??k}
async function run(fn:()=>Promise<any>){busy.value=true;error.value='';try{status.value=await fn()}catch(e){error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false}}
function setPref(key:Pref,value:boolean){return run(()=>ipcRenderer.invoke('sulla-cloud-connection:set-preferences',{[key]:value}))}
function enableRecommended(){return run(()=>ipcRenderer.invoke('sulla-cloud-connection:enable-recommended'))}
async function toggleKind(key:Pref,value:boolean,title:string){if(value)return setPref(key,true);await setPref(key,false);if(key==='remoteAccess')return;if(window.confirm(`Delete the ${title} copy already stored in Sulla Cloud?\n\nChoose Cancel to keep the Cloud copy.`))await run(()=>ipcRenderer.invoke('sulla-cloud-connection:delete-cloud-copy',key))}
function syncNow(){return run(()=>ipcRenderer.invoke('sulla-cloud-connection:sync-now','all'))}function deleteAll(){if(!window.confirm('Delete everything this Desktop synced to Sulla Cloud? Nothing on this Desktop changes.'))return;return run(()=>ipcRenderer.invoke('sulla-cloud-connection:delete-cloud-copy','all'))}
function onStatus(_e:unknown,s:Record<string,any>){status.value=s}onMounted(async()=>{ipcRenderer.on('sulla-cloud-connection:status-changed',onStatus);await run(()=>ipcRenderer.invoke('sulla-cloud-connection:get-status'))});onBeforeUnmount(()=>ipcRenderer.removeListener('sulla-cloud-connection:status-changed',onStatus));
</script>
<style scoped>
.sync-card{margin-top:14px;
border:1px solid var(--border-default);
border-radius:12px;
overflow:hidden;
background:var(--bg-surface)}
.master{display:flex;
gap:16px;
align-items:flex-start;
padding:20px}
.master h2{margin:0 0 4px;
font-size:16px}
.destination{display:inline-block;
margin-bottom:6px;
color:var(--accent);
font-size:12px;
font-weight:600}
.master p,.note{margin:0;
color:var(--text-muted);
font-size:12px;
line-height:1.5}
.master .switch{margin-left:auto}
.recommend{margin-top:10px;padding:6px 10px;border:1px solid var(--accent);border-radius:7px;background:var(--bg-surface);color:var(--accent);cursor:pointer;font-size:12px}
.recommend:disabled{opacity:.5;cursor:default}
.status{display:flex;
gap:18px;
padding:11px 20px;
border-top:1px solid var(--border-default);
background:var(--bg-page);
font-size:12px;
color:var(--text-muted)}
.status b{color:var(--status-success)}
.section{padding:10px 20px 6px;
border-top:1px solid var(--border-default);
color:var(--text-muted);
font-size:10px;
font-weight:700;
letter-spacing:.08em;
text-transform:uppercase}
.row{display:grid;
grid-template-columns:30px minmax(180px,1fr) auto 44px;
gap:14px;
align-items:center;
padding:12px 20px;
border-top:1px solid var(--border-default)}
.icon{width:30px;
height:30px;
border-radius:8px;
display:grid;
place-items:center;
background:var(--accent-dim);
color:var(--accent)}
.copy b,.link{display:block;
font:500 13px inherit;
color:var(--text-primary);
padding:0;
border:0;
background:none}
.link{cursor:pointer}
.copy small{display:block;
color:var(--text-muted);
font-size:11.5px;
margin-top:2px}
.privacy{padding:2px 8px;
border-radius:9px;
font-size:11px;
white-space:nowrap}
.privacy.private{background:var(--status-success-soft);
color:var(--status-success)}
.privacy.account{background:var(--bg-page);
color:var(--text-muted)}
.switch{position:relative;
width:44px;
height:24px}
.switch input{position:absolute;
opacity:0}
.switch span{display:block;
width:44px;
height:24px;
border-radius:12px;
background:var(--bg-surface-hover);
cursor:pointer}
.switch span:after{content:'';
display:block;
width:18px;
height:18px;
border-radius:50%;
background:var(--bg-surface);
transform:translate(3px,3px);
transition:.15s;
box-shadow:0 1px 3px rgba(0, 0, 0, .27)}
.switch input:checked+span{background:var(--accent)}
.switch input:checked+span:after{transform:translate(23px,3px)}
.switch input:disabled+span{opacity:.35;
cursor:default}
.footer{display:grid;
grid-template-columns:auto 1fr auto;
gap:8px;
padding:14px 20px;
border-top:1px solid var(--border-default)}
.btn{min-height:32px;
padding:0 13px;
border:1px solid var(--border-strong);
border-radius:8px;
background:var(--bg-surface);
color:var(--text-primary);
cursor:pointer}
.danger,.error{color:var(--status-error)}
.note{padding:12px 20px;
border-top:1px solid var(--border-default)}
.alert,.error{padding:10px 20px;
background:var(--status-error-soft);
font-size:12px}
.devices { margin: 4px 16px 12px; padding: 10px 14px; border: 1px solid var(--border-default); border-radius: 10px; }
.drow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border-default); }
.drow:last-of-type { border-bottom: 0; }
.drow small { display: block; opacity: .7; font-size: 11.5px; }
.drow code { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 11.5px; }
.pill { padding: 2px 8px; border-radius: 999px; font-size: 11px; }
.pill.on { background: var(--status-success-soft); color: var(--status-success); }
.pill.off { background: var(--bg-surface-hover); }
</style>
