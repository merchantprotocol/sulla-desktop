import { pushAgentProjection } from '@pkg/agent/tools/agents/cloudProjection';
import { cloudRequest, isCloudSignedIn } from '../cloudFetch';
import { getCloudPreferences, isCloudKindEnabled } from '../cloudSettings';
import { pushWorkflowProjection } from './workflows';
import Logging from '@pkg/utils/logging';
const console=Logging.background,CHECK_MS=15_000,FORCE_MS=60_000;
let timer:ReturnType<typeof setInterval>|null=null,busy=false;
const lastHash={workflows:'',liveAgents:''},lastPush={workflows:0,liveAgents:0};
async function upload(path:string,body:unknown){const r=await cloudRequest('PUT',path,{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error(`projection upload failed (${r.status})`)}
export async function syncRuntimeProjections(force=false){if(busy||!await isCloudSignedIn())return;const prefs=await getCloudPreferences();if(!prefs.enabled)return;busy=true;try{
 const jobs:Promise<void>[]=[];
 if(isCloudKindEnabled(prefs,'workflows')){const {buildWorkflowProjection}=await import('./workflows');const hash=JSON.stringify(await buildWorkflowProjection());if(force||hash!==lastHash.workflows||Date.now()-lastPush.workflows>=FORCE_MS)jobs.push(pushWorkflowProjection(upload).then(()=>{lastHash.workflows=hash;lastPush.workflows=Date.now()}))}
 if(isCloudKindEnabled(prefs,'liveAgents')){const {buildAgentProjection}=await import('@pkg/agent/tools/agents/cloudProjection');const hash=JSON.stringify(await buildAgentProjection());if(force||hash!==lastHash.liveAgents||Date.now()-lastPush.liveAgents>=FORCE_MS)jobs.push(pushAgentProjection(upload).then(()=>{lastHash.liveAgents=hash;lastPush.liveAgents=Date.now()}))}
 await Promise.all(jobs);
}catch(e){console.warn(`[CloudRuntimeProjection] ${e instanceof Error?e.message:e}`)}finally{busy=false}}
export const CloudRuntimeProjectionSync={start(){if(timer)return;void syncRuntimeProjections(true);timer=setInterval(()=>void syncRuntimeProjections(false),CHECK_MS);timer.unref?.()},stop(){if(timer)clearInterval(timer);timer=null;lastHash.workflows=lastHash.liveAgents='';lastPush.workflows=lastPush.liveAgents=0},changed(){void syncRuntimeProjections(false)}};
