// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { LeadHandoffRepository,LeadHandoffSnapshot } from '../Repositories/LeadHandoffRepository';

export class LeadHandoffPacketAssembler {
  constructor(private readonly repository:LeadHandoffRepository,private readonly checkinLimit=5){}
  async assemble(jobId:string,taskIndex:number,note?:string):Promise<{prompt:string;snapshot:LeadHandoffSnapshot}|undefined>{
    const snapshot=await this.repository.snapshot(jobId,taskIndex); if(!snapshot)return undefined;
    const task=snapshot.lead.tasks[taskIndex];
    const workers=snapshot.children.flatMap(child=>child.tasks.map((worker,index)=>({child,index,worker})));
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
    lines.push(``,`## Undelivered results/inbox (${snapshot.inbox.length})`);
    for(const row of snapshot.inbox) lines.push(`- ${row.kind}: ${row.body}`);
    lines.push(``,`## Queued messages (${snapshot.messages.length})`);
    for(const row of snapshot.messages) lines.push(`- ${row.message}`);
    const resume=[task.prompt,...snapshot.checkins.map(c=>c.summary)].join('\n').match(/(?:\/mnt\/[^\s)`]+|resume[^\n.]*)/gi)??[];
    if(resume.length) lines.push(``,`## Resume references`,...resume.map(value=>`- ${value}`));
    if(note?.trim()) lines.push(``,`## Caller note`,note.trim());
    lines.push(``,`Continue managing these existing workers. Do not relaunch them.`);
    return {prompt:lines.join('\n'),snapshot};
  }
}
