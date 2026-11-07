// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { LeadHandoffRepository,LeadHandoffSnapshot } from '../Repositories/LeadHandoffRepository';

export class LeadHandoffPacketAssembler {
  constructor(private readonly repository:LeadHandoffRepository,private readonly checkinLimit=5){}
  recordReplacementAudit(jobId:string,taskIndex:number,summary:string):Promise<void>{return this.repository.recordReplacementAudit(jobId,taskIndex,summary);}
  operation(...args:Parameters<LeadHandoffRepository['operation']>){return this.repository.operation(...args);}
  loadOperation(...args:Parameters<LeadHandoffRepository['loadOperation']>){return this.repository.loadOperation(...args);}
  saveLaunched(...args:Parameters<LeadHandoffRepository['saveLaunched']>){return this.repository.saveLaunched(...args);}
  saveOperation(...args:Parameters<LeadHandoffRepository['saveOperation']>){return this.repository.saveOperation(...args);}
  listDirectChildren(...args:Parameters<LeadHandoffRepository['listDirectChildren']>){return this.repository.listDirectChildren(...args);}
  claimAudit(...args:Parameters<LeadHandoffRepository['claimAudit']>){return this.repository.claimAudit(...args);}
  markChildrenMoved(...args:Parameters<LeadHandoffRepository['markChildrenMoved']>){return this.repository.markChildrenMoved(...args);}
  lockOperation(...args:Parameters<LeadHandoffRepository['lockOperation']>){return this.repository.lockOperation(...args);}
  finishWrapUp(...args:Parameters<LeadHandoffRepository['finishWrapUp']>){return this.repository.finishWrapUp(...args);}
  markWrapRequested(...args:Parameters<LeadHandoffRepository['markWrapRequested']>){return this.repository.markWrapRequested(...args);}
  async assemble(jobId:string,taskIndex:number,note?:string):Promise<{prompt:string;snapshot:LeadHandoffSnapshot}|undefined>{
    const snapshot=await this.repository.snapshot(jobId,taskIndex); if(!snapshot)return undefined;
    const task=snapshot.lead.tasks[taskIndex];
    const workers=snapshot.children.map(({job,taskIndex:index})=>({child:job,index,worker:job.tasks[index]}));
    const lines=[`# Lead replacement handoff`,`You are replacing lead task \`${jobId}:${taskIndex}\`.`,``,`## Original brief`,task.prompt,``,`## Your team: ${workers.length} workers`];
    for(const {child,index,worker} of workers){
      const telemetry=await this.repository.messaging.telemetryForJob(child.jobId);
      const latest=telemetry[index]?.latestCheckin;
      const result=worker.completion??child.results[index];
      const evidence=[latest?.summary,result?.output].filter(Boolean).join(' ');
      const heads=evidence.match(/(?:PR\s*#?\d+|https?:\/\/\S+|\b[0-9a-f]{7,40}\b|\b(?:feat|fix|hotfix)\/[\w./-]+)/gi)??[];
      lines.push(`- **${worker.label}** — ${worker.status}; job \`${child.jobId}\` task ${index}; thread \`${worker.threadId??'pending'}\`${heads.length?`; heads: ${[...new Set(heads)].join(', ')}`:''}`);
    }
    lines.push(``,`## Recent lead check-ins`);
    for(const item of snapshot.checkins.slice(0,this.checkinLimit)) lines.push(`- ${item.step}: ${item.summary}${item.blockers?.length?` (blockers: ${item.blockers.join('; ')})`:''}`);
    const inboxCompletionKeys=new Set(snapshot.inbox.map(row=>`${row.ids?.jobId??''}:${row.ids?.taskIndex??''}`));
    const completions=snapshot.completions.filter(row=>!inboxCompletionKeys.has(`${row.job_id}:${row.task_index}`));
    lines.push(``,`## Undelivered results/inbox (${snapshot.inbox.length+completions.length})`);
    for(const row of snapshot.inbox) lines.push(`- ${row.kind}: ${row.body}`);
    for(const row of completions) lines.push(`- contract ${row.job_id}:${row.task_index}: ${JSON.stringify({status:row.task_status,summary:row.summary,output:row.completion?.output??row.result?.output??row.completion??row.result})}`);
    lines.push(``,`## Queued messages (${snapshot.messages.length})`);
    for(const row of snapshot.messages) lines.push(`- ${row.message}`);
    const resume=[task.prompt,...snapshot.checkins.map(c=>c.summary)].join('\n').match(/(?:\/mnt\/[^\s)`]+|resume[^\n.]*)/gi)??[];
    if(resume.length) lines.push(``,`## Resume references`,...resume.map(value=>`- ${value}`));
    if(note?.trim()) lines.push(``,`## Caller note`,note.trim());
    lines.push(``,`Continue managing these existing workers. Do not relaunch them.`);
    return {prompt:lines.join('\n'),snapshot};
  }
}
