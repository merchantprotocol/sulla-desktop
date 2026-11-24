// SPDX-License-Identifier: GPL-2.0-or-later
import { computed, type ComputedRef, type InjectionKey, type Ref } from 'vue';

import type { DecisionRecord } from '@pkg/shared/decisions';
import type { AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { ThreadAgentActivityProjection } from '@pkg/services/agentState/ThreadAgentActivityPresenter';
import type { StatusRollupItem } from '../components/composer/StatusRollupQueue';
import type { WorkerChartAgent } from '../components/workerChart/workerChartModel';

export interface ThreadAgentActivitySources {
  readonly snapshot: Readonly<Ref<AgentStateSnapshot>>;
  readonly threadId: Readonly<Ref<string | undefined>>;
  readonly decisions?: Readonly<Ref<readonly DecisionRecord[]>>;
}

/** Reactive view-model shared by ChatPage, the composer status line, and WorkerChart. */
export interface ThreadAgentActivity {
  readonly projection: ComputedRef<ThreadAgentActivityProjection>;
  readonly checkIns: ComputedRef<StatusRollupItem[]>;
  readonly rootFallback: ComputedRef<StatusRollupItem | null>;
  readonly chartRoot: ComputedRef<WorkerChartAgent | null>;
}

export const THREAD_AGENT_ACTIVITY_KEY: InjectionKey<ThreadAgentActivity> = Symbol('ThreadAgentActivity');

/**
 * Initial integration stub: it is safe to mount while the live presenter
 * adapter is being wired, and gives Composer a stable import contract.
 */
export function useThreadAgentActivity(sources: ThreadAgentActivitySources): ThreadAgentActivity {
  return {
    projection: computed(() => ({
      threadId: sources.threadId.value,
      scope: 'empty',
      decisionIds: [],
      pendingDecisionIds: [],
      roots: [],
      agents: [],
    })),
    checkIns: computed(() => []),
    rootFallback: computed(() => null),
    chartRoot: computed(() => null),
  };
}
