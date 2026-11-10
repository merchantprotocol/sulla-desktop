// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TaskExecutionIdentityStore } from '../Repositories/TaskExecutionIdentityRepository';

export interface TaskExecutionAssignment { jobId:string; taskIndex:number; store:TaskExecutionIdentityStore }

/** Carries the injected durable identity repository through the provider launch boundary. */
export class TaskExecutionIdentityScope {
  private readonly storage=new AsyncLocalStorage<TaskExecutionAssignment>();
  run<T>(assignment:TaskExecutionAssignment,action:()=>T):T{return this.storage.run(assignment,action);}
  current():TaskExecutionAssignment|undefined{return this.storage.getStore();}
}

export const taskExecutionIdentityScope=new TaskExecutionIdentityScope();
