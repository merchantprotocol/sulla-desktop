// SPDX-License-Identifier: GPL-2.0-or-later

import type { WorkerModelRoute } from '../languagemodels/workerModelBindings';
import type { BaseThreadState } from '../nodes/Graph';

export class WorkerModelThreadState {
  static install(state: BaseThreadState, route: WorkerModelRoute | undefined, task?: { jobId: string; taskIndex: number; generation?: number }): void {
    const meta = state.metadata as any;
    if (route) meta.workerModelRoute = JSON.parse(JSON.stringify(route));
    else delete meta.workerModelRoute;
    if (route && task) meta.workerModelTask = { ...task, generation: task.generation ?? 1 };
    else delete meta.workerModelTask;
  }

  static detachTerminalChat(state: BaseThreadState): void {
    const meta = state.metadata as any;
    for (const key of ['delegatedJobId', 'inheritedResumeModel', 'savedInheritedModel', 'delegatedGeneration', 'productOwnerWorkflowStep', 'workerModelTask', 'workerModelRoute', 'delegatedTaskIndex', 'managerAgentId', 'managerThreadId', 'workflowParentChannel', 'parentWsChannel', 'activityKeys']) delete meta[key];
    if (!meta.workerModelChatOverride && meta.agent) {
      delete meta.agent.provider;
      delete meta.agent.model;
      delete meta.agent.effort;
    }
  }

  static isHumanTurn(type: string, channel: string, metadata?: Record<string, any>): boolean {
    return type === 'user_message' && metadata?.inputSource !== 'system' && !metadata?.origin && !channel.toLowerCase().includes('heartbeat');
  }
}

export const installWorkerRoute = WorkerModelThreadState.install;
export const detachTerminalWorkerChat = WorkerModelThreadState.detachTerminalChat;
export const isWorkerMappingHumanTurn = WorkerModelThreadState.isHumanTurn;
