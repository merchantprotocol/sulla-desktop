// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service } from '@sulla/foundation';
import type {
  LaunchingTaskExecution,
  TaskExecutionDiscoveryHandle,
  TaskExecutionIdentityInput,
  TaskExecutionLaunchReservation,
} from '../Repositories/TaskExecutionIdentityRepository';

export interface LaunchingTaskExecutionRepository {
  launching():Promise<LaunchingTaskExecution[]>;
  activate(reservation:TaskExecutionLaunchReservation,identity:TaskExecutionIdentityInput):Promise<unknown>;
  requireManualReconciliation(reservation:TaskExecutionLaunchReservation,reason:string):Promise<void>;
}

export interface TaskExecutionDiscoveryTransport {
  discover(handle:TaskExecutionDiscoveryHandle,expected:{jobId:string;taskIndex:number}):Promise<TaskExecutionIdentityInput|undefined>;
}

/** Converts crash-left launch reservations into exact identities or a durable manual-reconciliation outcome. */
export class LaunchingTaskExecutionReconciler extends Service {
  constructor(
    private readonly repository:LaunchingTaskExecutionRepository,
    private readonly transport:TaskExecutionDiscoveryTransport,
  ){super();}

  async reconcile():Promise<void>{
    for(const launch of await this.repository.launching())await this.reconcileLaunch(launch);
  }

  private async reconcileLaunch(launch:LaunchingTaskExecution):Promise<void>{
    if(!launch.discoveryHandle){
      await this.repository.requireManualReconciliation(launch,'Launch interrupted before a durable discovery handle was recorded');
      return;
    }
    try{
      const identity=await this.transport.discover(launch.discoveryHandle,{jobId:launch.jobId,taskIndex:launch.taskIndex});
      if(identity){await this.repository.activate(launch,identity);return;}
      await this.repository.requireManualReconciliation(launch,'Launch discovery handle is unavailable; execution stop cannot be confirmed safely');
    }catch(error){
      await this.repository.requireManualReconciliation(launch,`Launch identity discovery failed; manual reconciliation required: ${ (error as Error).message }`);
    }
  }
}
