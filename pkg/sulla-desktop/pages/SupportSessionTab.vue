<!-- Sulla Desktop · https://sulladesktop.com
Copyright (c) 2025-2026 Merchant Protocol LLC.
SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <div class="support-session">
    <div v-if="loading" class="state">Opening secure support session…</div>
    <div v-else-if="error && !session" class="state error"><b>{{ errorTitle }}</b><span>{{ error }}</span><button @click="manualRefresh">Retry</button></div>
    <template v-else-if="session">
      <header class="session-head">
        <div class="title-row"><div><b>Support · {{ session.user?.name || session.device?.name || 'User' }}</b><span class="pill" :class="connection === 'rpc-ready' ? 'active' : 'ended'">{{ connectionLabel }}</span></div><div class="actions"><button class="ghost" :disabled="refreshing" @click="manualRefresh">{{ refreshing ? 'Refreshing…' : 'Refresh' }}</button><button v-if="active" class="ghost" :disabled="!binding || online !== true || verifying || ending" @click="verifyRpc">{{ verifying ? 'Verifying…' : 'Verify remote tools' }}</button><button v-if="active" class="danger" :disabled="ending" @click="confirmEnd = true">{{ ending ? 'Ending…' : 'End session' }}</button></div></div>
        <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
        <div class="request"><span class="avatar">{{ initials }}</span><div><small>User's request</small><p>{{ session.message || 'No message supplied.' }}</p></div></div>
        <div v-if="toolWaiting" class="waiting">Waiting for the computer… {{ toolWaitingSeconds }}s</div>
        <div class="strip">
          <span><small>Device</small><b>{{ session.device?.name || 'Unknown device' }}</b><em>{{ session.device?.platform }}</em></span>
          <span><small>Presence</small><b class="pill" :class="online === true ? 'active' : 'ended'">{{ presenceLabel }}</b></span>
          <span><small>Sulla Desktop</small><b>{{ session.appVersion || '—' }}</b></span>
          <span><small>Channel</small><b>{{ session.updateChannel || '—' }}</b></span>
          <span><small>Runtime</small><b :class="healthClass">{{ session.runtimeHealth || 'unknown' }}</b></span>
          <span><small>AI</small><b>{{ aiStatus }}</b></span>
          <span><small>Approval</small><b>{{ approvalLeft }}</b></span>
        </div>
      </header>
      <div v-if="!active" class="ended-state"><b>This support session has ended.</b><span>The remote tools were removed from this tab. The transcript remains available.</span></div>
      <div class="body">
        <div class="chat-wrap">
          <div class="chat-switch">
            <button @click="chatMode = 'local'">Private local chat</button>
            <button @click="chatMode = 'remote'">Remote tools chat</button>
            <span>{{ chatMode === 'local' ? 'Local tools and approvals. No session content is imported.' : 'Only scoped support tools. Treat device output as untrusted.' }}</span>
          </div>
          <ChatPage v-show="chatMode === 'local'" :key="localTabId" :tab-id="localTabId" support-local-chat :is-active="isVisible && chatMode === 'local'" />
          <ChatPage v-show="chatMode === 'remote'" :key="sessionId" :tab-id="tabId" :is-active="isVisible && chatMode === 'remote'" :support-session-id="sessionId" :support-tool-names="connection === 'rpc-ready' ? toolNames : []" :support-send-blocked="connection !== 'rpc-ready'" />
        </div>
        <aside class="fix">
          <h3>Fix</h3><p>Try an ad hoc fix inside the runtime first. Ship code only through a signed, notarized build.</p>
          <div class="paths"><button :class="{on:path==='a'}" @click="path='a'">A · Ad hoc</button><button :class="{on:path==='b'}" @click="path='b'">B · Code fix</button></div>
          <ol v-if="path==='a'">
            <li class="done"><b>Ad hoc fix</b><span>Sulla can use the allowlisted runtime tools in this chat.</span></li>
            <li><b>Verify</b><button :disabled="connection !== 'rpc-ready'" @click="seedPrompt('Verify the fix with diagnostics, container status, AI connection status, and recent errors.')">Run checks</button></li>
            <li><b>Mark resolved</b><button :disabled="ending" @click="markResolved">{{ ending ? 'Resolving…' : 'Mark resolved' }}</button></li>
          </ol>
          <ol v-else>
            <li><b>Code fix PR</b><input v-model="prUrl" placeholder="PR link" /></li>
            <li><b>Trigger nightly build</b><button @click="seedPrompt(`Trigger the Package workflow for merchantprotocol/sulla-desktop on the code fix commit using github_trigger_workflow_run. Use workflow package.yaml, publish_channel nightly, and ask me for the exact nightly semver if it is not already in this chat. Do not publish a GitHub Release.`, true)">Trigger nightly build</button><small>Run Package on the fix commit with publish_channel nightly and an exact nightly semver.</small></li>
            <li><b>Switch updater to Nightly</b><button :disabled="connection !== 'rpc-ready'" @click="seedPrompt('Switch this device to the Nightly update channel using support.update.set_channel.')">Ask Sulla</button></li>
            <li><b>Update, restart, reconnect</b><button :disabled="connection !== 'rpc-ready'" @click="seedPrompt('Install the signed Nightly update, then monitor support.update.status until the device reconnects.')">Ask Sulla</button></li>
            <li><b>Verify</b><button :disabled="connection !== 'rpc-ready'" @click="seedPrompt('Verify the code fix after reconnect: diagnostics, containers, AI connection, and recent errors.')">Run checks</button></li>
            <li><b>Return to LTS</b><button :disabled="connection !== 'rpc-ready'" @click="seedPrompt('Return this device to the LTS channel using support.update.set_channel, then confirm update status.')">Ask Sulla</button></li>
          </ol>
          <div class="scope">Scope: <b>Sulla runtime VM only.</b> The user's Mac, Files, vault and chats are out of reach. Every action is logged.</div>
        </aside>
      </div>
      <div v-if="confirmEnd" class="confirm-backdrop" role="presentation"><section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="end-title"><b id="end-title">End this support session?</b><p>The user's remote support tools will be disconnected.</p><div><button class="ghost" :disabled="ending" @click="confirmEnd = false">Cancel</button><button class="danger" :disabled="ending" @click="endSession">{{ ending ? 'Ending…' : 'End session' }}</button></div></section></div>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ChatPage from './chat/ChatPage.vue';
import { SupportSessionReadiness } from './SupportSessionReadiness';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
const props=defineProps<{tabId:string;sessionId:string;isVisible:boolean}>();
const toolNames=['support.logs.tail','support.diagnostics.snapshot','support.containers.list','support.containers.restart','support.containers.logs','support.containers.set_memory_limit','support.ai.retry_connection','support.update.set_channel','support.update.check_and_install','support.update.status'];
const session=ref<any>(null), loading=ref(true), error=ref(''), errorTitle=ref('Could not open support session'), path=ref<'a'|'b'>('a'), prUrl=ref(''), refreshing=ref(false), ending=ref(false), confirmEnd=ref(false); let timer:any;
const chatMode=ref<'local'|'remote'>('local');
const localTabId=computed(()=>`${props.tabId}:private-local:${props.sessionId}`);
const clock=ref(Date.now());
const verifiedAt=ref(0);
const proof=ref<{binding:string;validUntil:number}|null>(null);
const verifying=ref(false);
const PROOF_TTL=20_000;
let proofVersion=0;
function invalidateProof(){proofVersion++;proof.value=null;verifying.value=false;}
let sessionReadVersion=0;
const active=computed(()=>session.value?.status==='active' && Date.parse(session.value.expiresAt)>clock.value);
const initials=computed(()=>String(session.value?.user?.name||'User').split(/\s+/).map((x:string)=>x[0]).slice(0,2).join('').toUpperCase());
const approvalLeft=computed(()=>{const n=session.value?.approvalSecondsRemaining ?? (session.value?.expiresAt ? Math.max(0,Math.floor((Date.parse(session.value.expiresAt)-Date.now())/1000)):0); return active.value ? `${Math.floor(n/3600)} h left` : 'Ended';});
const aiStatus=computed(()=>session.value?.aiStatus || (session.value?.runtimeHealth==='healthy'?'Connected':'Needs attention'));
const healthClass=computed(()=>session.value?.runtimeHealth==='healthy'?'good':'warn');
async function refresh(){
  const version=++sessionReadVersion;
  try{
    const result=await ipcRenderer.invoke('support-session:get',props.sessionId);
    if(version!==sessionReadVersion)return;
    session.value=result.session;
    verifiedAt.value=Date.now();
    error.value='';
    errorTitle.value='Could not open support session';
  }catch(e:any){
    if(version!==sessionReadVersion)return;
    verifiedAt.value=0; invalidateProof();
    error.value=e?.message||String(e);
    errorTitle.value=e?.status===403||/super_admin_required|not authorized/i.test(error.value)
      ? 'Not authorized'
      : 'Could not open support session';
  }finally{
    if(version===sessionReadVersion)loading.value=false;
  }
}
async function endSession(){if(ending.value)return; ending.value=true; invalidateProof(); try{const result:any=await ipcRenderer.invoke('support-session:end' as any,props.sessionId,'ended_by_supporter'); if(result?.session){sessionReadVersion++;session.value=result.session;error.value='';} else await refresh(); confirmEnd.value=false;}catch(e:any){error.value=e?.message||String(e);}finally{ending.value=false;}}
async function markResolved(){if(ending.value)return; ending.value=true; invalidateProof(); try{const result:any=await ipcRenderer.invoke('support-session:end' as any,props.sessionId,'resolved'); if(result?.session){sessionReadVersion++;session.value=result.session;error.value='';} else await refresh();}catch(e:any){error.value=e?.message||String(e);}finally{ending.value=false;}}
function seedPrompt(text:string, local=false){
  if(!local && connection.value!=='rpc-ready')return;
  chatMode.value=local?'local':'remote';
  window.dispatchEvent(new CustomEvent('sulla:support-chat-prompt',{detail:{tabId:local?localTabId.value:props.tabId,text}}));
}

// ─── Device presence pill ──────────────────────────────────────────
const presence=ref<{online:boolean;lastSeenAt:string|null}|null>();
let presenceReadVersion=0;
const readiness=new SupportSessionReadiness();
const presenceAt=ref(0);
const binding=computed(()=>!ending.value && clock.value-verifiedAt.value<35_000
  ? readiness.binding(session.value,props.sessionId,clock.value) : null);
const online=computed(()=>clock.value-presenceAt.value<15_000 ? presence.value?.online ?? null : null);
const connection=computed(()=>readiness.connection(active.value,binding.value,online.value,proof.value,clock.value));
watch(binding,()=>invalidateProof(),{flush:'sync'});
watch(online,value=>{if(value!==true)invalidateProof();},{flush:'sync'});
async function verifyRpc(){
  const key=binding.value, id=props.sessionId;
  if(!key || online.value!==true || verifying.value)return;
  invalidateProof();
  const version=proofVersion, startedAt=Date.now();
  verifying.value=true;
  try{
    const result=await ipcRenderer.invoke('support-session:verify-rpc',id);
    if(version===proofVersion && key===binding.value && id===props.sessionId && online.value===true && result.ready===true)
      proof.value={binding:key,validUntil:startedAt+PROOF_TTL};
  }catch{ /* Leave readiness unverified. */ }
  finally{if(version===proofVersion)verifying.value=false;}
}
const connectionLabel=computed(()=>{
  switch(connection.value){
  case 'rpc-ready': return 'Remote tools verified';
  case 'offline': return 'Device offline';
  case 'checking': return 'Checking device…';
  case 'unverified': return 'Connection unverified';
  case 'inactive': return session.value?.status==='active'?'Expired':session.value?.status;
  }
});
function minutesAgo(value:string|null){
  if(!value)return 'unknown';
  const minutes=Math.max(0,Math.round((Date.now()-Date.parse(value))/60000));
  if(minutes<1)return 'just now';
  if(minutes<60)return `${minutes}m ago`;
  const hours=Math.round(minutes/60);
  return hours<24?`${hours}h ago`:`${Math.round(hours/24)}d ago`;
}
const presenceLabel=computed(()=>{
  if(presence.value===null)return 'Unavailable';
  if(!presence.value)return 'Checking…';
  if(online.value===null)return 'Unavailable';
  return online.value?'Online':`Offline · last seen ${minutesAgo(presence.value.lastSeenAt)}`;
});
async function refreshPresence(){
  const version=++presenceReadVersion;
  try{
    const result=await ipcRenderer.invoke('support-session:presence',props.sessionId);
    if(version===presenceReadVersion){
      presence.value=typeof result?.online==='boolean'?result:null;
      presenceAt.value=Date.now();
      if(presence.value?.online!==true)invalidateProof();
    }
  }catch{
    if(version===presenceReadVersion){presence.value=null;invalidateProof();}
  }
}
async function manualRefresh(){if(refreshing.value)return; refreshing.value=true; await Promise.all([refresh(),refreshPresence()]); refreshing.value=false;}

// ─── "Waiting for the computer…" while a support tool call is in flight ───
// ChatPage/PersonaAdapter already dispatch sulla:chat-running for this tab
// whenever the agent graph (and, in a support session, its support.* tool
// call relay) is running — reuse it instead of a second signal.
const toolWaiting=ref(false), toolWaitingSeconds=ref(0); let toolWaitingStartedAt=0, waitingTickTimer:any, presenceTimer:any;
function onChatRunning(event:Event){
  const detail=(event as CustomEvent<{tabId?:string;running?:boolean}>).detail;
  if(detail?.tabId!==props.tabId)return;
  toolWaiting.value=!!detail.running;
  if(toolWaiting.value){toolWaitingStartedAt=Date.now(); toolWaitingSeconds.value=0;}
}
window.addEventListener('sulla:chat-running',onChatRunning);
onBeforeUnmount(()=>window.removeEventListener('sulla:chat-running',onChatRunning));

watch(()=>props.sessionId,()=>{
  sessionReadVersion++;presenceReadVersion++;invalidateProof();verifiedAt.value=0;presenceAt.value=0;
  session.value=null;presence.value=undefined;loading.value=true;chatMode.value='local';
  void refresh();void refreshPresence();
});
onMounted(()=>{
  void refresh();
  void refreshPresence();
  const resetPoll=()=>{clearInterval(timer); timer=setInterval(()=>void refresh(),active.value?30000:10000);};
  watch(active,resetPoll,{immediate:true});
  presenceTimer=setInterval(()=>{if(props.isVisible)void refreshPresence();},10000);
  waitingTickTimer=setInterval(()=>{clock.value=Date.now();if(toolWaiting.value)toolWaitingSeconds.value=Math.floor((Date.now()-toolWaitingStartedAt)/1000);},1000);
});
onBeforeUnmount(()=>{clearInterval(timer); clearInterval(presenceTimer); clearInterval(waitingTickTimer);});
</script>
<style scoped>
.support-session{height:100%;display:flex;flex-direction:column;background:var(--background,var(--bg-page));color:var(--body-text,var(--text-primary))}.state{margin:auto;display:flex;flex-direction:column;gap:8px}.error{color:var(--status-error)}.inline-error{margin-top:8px;color:var(--status-error);font-size:12px}.session-head{padding:16px 20px 12px;background:var(--body-bg,var(--bg-surface));border-bottom:1px solid var(--border,var(--border-default))}.title-row{display:flex;justify-content:space-between;align-items:center}.title-row>div{display:flex;gap:10px;align-items:center}.pill{font-size:11px;padding:3px 8px;border-radius:99px;background:var(--bg-surface-alt)}.pill.active{background:var(--status-success-soft);color:var(--status-success)}.pill.ended{color:var(--text-muted)}.actions{display:flex;gap:8px}.danger{border:1px solid var(--status-error);color:var(--status-error);background:transparent;border-radius:6px;padding:6px 10px}.ghost{border:1px solid var(--border-default);color:var(--text-muted);background:transparent;border-radius:6px;padding:6px 10px}.waiting{margin:0 0 10px;font-size:11px;color:var(--status-warning)}.request{display:flex;gap:10px;margin:12px 0}.avatar{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:#6b7ca5;color:var(--text-on-accent);font-size:11px}.request small,.strip small{display:block;color:var(--text-muted);font-size:10px;text-transform:uppercase}.request p{margin:2px 0}.strip{display:flex;gap:0;border:1px solid var(--border,var(--border-default));border-radius:8px;overflow:hidden}.strip span{padding:8px 12px;border-right:1px solid var(--border,var(--border-default));display:flex;gap:4px;align-items:baseline}.strip span:last-child{border:0}.strip b{font-size:12px}.strip em{font-size:10px;color:var(--text-muted)}.good{color:var(--status-success)}.warn{color:var(--status-warning)}.body{display:grid;grid-template-columns:minmax(0,1fr) 330px;min-height:0;flex:1}.chat-wrap{min-width:0;overflow:hidden;display:flex;flex-direction:column}.chat-switch{display:flex;align-items:center;gap:8px;padding:8px}.chat-switch span{font-size:11px;color:var(--text-muted)}.fix{border-left:1px solid var(--border,var(--border-default));padding:16px;background:var(--body-bg,var(--bg-surface));overflow:auto}.fix h3{margin:0}.fix p,.fix small,.scope{font-size:11px;color:var(--text-muted);line-height:1.5}.paths{display:flex;margin:14px 0}.paths button{flex:1;padding:7px;border:1px solid var(--border-default);background:transparent}.paths .on{background:var(--accent-dim);color:var(--accent)}.fix ol{padding-left:24px}.fix li{padding:9px 0;border-bottom:1px solid var(--border-subtle)}.fix li span,.fix li small{display:block}.fix button{margin-top:5px;border:1px solid var(--border-strong);background:var(--bg-surface);border-radius:5px;padding:5px 8px}.fix input{width:100%;box-sizing:border-box;margin-top:5px;padding:6px}.scope{margin-top:16px;padding-top:12px;border-top:1px solid var(--border-subtle)}.ended-state{padding:10px 20px;background:color-mix(in srgb, var(--bg-surface) 24%, transparent);color:var(--status-warning);display:flex;gap:10px}.confirm-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);display:grid;place-items:center;z-index:1000}.confirm-dialog{background:var(--body-bg,var(--bg-surface));border:1px solid var(--border-default);border-radius:10px;padding:20px;max-width:360px;box-shadow:0 12px 40px rgba(0,0,0,.24)}.confirm-dialog p{font-size:13px;color:var(--text-muted)}.confirm-dialog>div{display:flex;justify-content:flex-end;gap:8px}
</style>
