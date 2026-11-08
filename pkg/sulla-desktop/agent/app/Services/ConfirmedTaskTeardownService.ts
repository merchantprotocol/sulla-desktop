// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service } from '@sulla/foundation';
import type { TaskExecutionIdentity,TaskExecutionIdentityStore } from '../Repositories/TaskExecutionIdentityRepository';
import type { TaskTeardownOutcome,TaskTeardownPort } from './TaskTeardownPort';

export interface TaskExecutionTerminationTransport {
  terminate(identity:TaskExecutionIdentity,expected:{jobId:string;taskIndex:number}):Promise<TaskTeardownOutcome>;
}

/** Resolves the persisted generation before asking the platform transport to stop it. */
export class ConfirmedTaskTeardownService extends Service implements TaskTeardownPort {
  constructor(private readonly identities:TaskExecutionIdentityStore,private readonly transport:TaskExecutionTerminationTransport){super();}
  async teardown(jobId:string,taskIndex:number):Promise<TaskTeardownOutcome>{
    const identity=await this.identities.find(jobId,taskIndex);
    if(!identity)return 'unavailable';
    try{return await this.transport.terminate(identity,{jobId,taskIndex});}catch{return 'unavailable';}
  }
}
