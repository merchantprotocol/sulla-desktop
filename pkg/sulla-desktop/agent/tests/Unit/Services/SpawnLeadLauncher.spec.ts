// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import {describe,expect,it,vi} from 'vitest';
import {SpawnLeadLauncher} from '../../../app/Services/SpawnLeadLauncher';

describe('SpawnLeadLauncher',()=>{
 it('uses the canonical SpawnAgentWorker seam and preserves the old custody owner as parent',async()=>{
   // risk: result routing — the replacement contract must wake the same logical parent.
   const runValidated=vi.fn(async()=>({successBoolean:true,responseString:'ok',result:{jobId:'new-job'}}));
   const jobs={job:vi.fn(async()=>({jobId:'new-job',tasks:[{threadId:'new-thread'}]}))};
   const launcher=new SpawnLeadLauncher(jobs as any,()=>({runValidated} as any));
   const result=await launcher.launchReplacement({oldJobId:'old-job',oldTaskIndex:2,agentId:'coding-manager-sol',prompt:'handoff',launchKey:'lead-replacement:old-job:2',owner:{channel:'sulla-desktop',threadId:'parent-thread',agentId:'parent-agent'}});
   expect(result).toEqual({jobId:'new-job',taskIndex:0,threadId:'new-thread'});
   expect(runValidated).toHaveBeenCalledWith(expect.objectContaining({tasks:[expect.objectContaining({agentId:'coding-manager-sol',prompt:'handoff',visibility:'hidden'})],async:true,launchKey:'lead-replacement:old-job:2'}),expect.objectContaining({metadata:expect.objectContaining({threadId:'parent-thread',routedAgentId:'parent-agent'})}));
 });
});
