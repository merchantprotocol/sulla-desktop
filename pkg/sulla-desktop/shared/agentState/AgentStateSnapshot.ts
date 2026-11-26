// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Live agent state contract shared by the main process (AgentStateService)
 * and the renderer (Live Agents, sub-agent drawer). Types only: no runtime
 * state lives in this module.
 *
 * Owned by epic/live-agents-accurate. Do not change without the epic
 * manager's approval: main and renderer are built against this exact shape.
 */

import type { AgentModelStatusValue } from './AgentModelStatus';
import type { ResultTracking } from '../agentResults/AgentResultCard';

export type AgentStopAttribution = { agentId: string; threadId: string } | { system: string } | 'human';

export type AgentRowState =
 | 'queued' // accepted, not started yet
 | 'working' // its graph is running a turn right now
 | 'parked' // turn ended, waiting on live children (waitingOnChildren > 0)
 | 'quiet' // marked running but no check-in for quietAfterMs
 | 'blocked' // reported a blocker in its latest check-in
 | 'failed' // ended with an error
 | 'lost' // marked running/queued but no live graph/container and no recent check-in
 | 'stopped' // stopped by a human or parent
 | 'done'; // returned its result

export interface AgentStateRow extends ResultTracking {
 /** Stable row key: `${jobId}:${taskIndex}` */
 key: string;
 jobId: string;
 taskIndex: number;
 /** Job/task that launched this one; null for agents launched straight from a chat. */
 parentJobId: string | null;
 parentTaskIndex: number | null;
 /** The chat thread at the top of the tree (the orchestrator's chat). */
 rootThreadId: string | null;
 /** This task's own thread, when it has one (tab or hidden graph). */
 threadId: string | null;
 /** 0 = launched directly from the root chat. */
 depth: number;
 agentId: string | null;
 /** True when this agent definition's live can_call policy permits delegation. */
 canLaunchAgents?: boolean;
 /** Product Owner stage recorded when this task was delegated. */
 workflowStep?: import('../productOwnerWorkflow').DelegatedWorkflowStep;
 responseModels?: AgentModelStatusValue[];
 /** Recovery attempts recorded for this job, shared by its tasks. */
 jobRestartResumeCount?: number;
 /** Explicit existing Projects task assignment. */
 taskId?:            string;
 modelStatus?:       AgentModelStatusValue;
 label: string;
 visibility: 'hidden' | 'tab';
 state: AgentRowState;
 /** Human-readable reason for failed / lost / blocked / quiet / stopped, and 'scheduled wake-up' for a timer-parked task. */
 stateReason: string | null;
 /** For a task parked on a timer: why it is waiting, in the agent's words ("CI full-tests running on 391bf1f"). */
 waitReason?: string | null;
 /** For a task parked on a timer: when it checks again. */
 wakeAt?: string | null;
 /** Durable actor that stopped this task, preferring task attribution over its job fallback. */
 stoppedBy?: AgentStopAttribution;
 /** Durable task stop reason, falling back to the job reason. */
 stopReason?: string;
 /** True only when the durable stop attribution identifies a human. */
 killedByHuman: boolean;
 /** Live (queued/working/parked/quiet/blocked) direct children. */
 waitingOnChildren: number;
 startedAt: string | null;
 endedAt: string | null;
 /** Latest task-scoped activity across start, check-in, model/tool turn, and settlement. */
 lastActivityAt: string;
 lastCheckinAt: string | null;
 lastCheckinSummary: string | null;
 /** The oldest tool call the task is still running (e.g. a long shell command), when known. */
 toolInFlight?: { name: string; since: string } | null;
 /** For a quiet container agent: whether its process is still alive (null when not known). */
 runtimeAlive?: boolean | null;
 /** True only when the source of truth says a message can be delivered right now. */
 canMessage: boolean;
 /** True only when the task is live and can be stopped. */
 canStop: boolean;
 /** True when the task has a thread that can be opened. */
 canOpen: boolean;
}

export interface AgentStateSnapshot {
 /** Monotonic; increases on every state change. Renderers drop older snapshots. */
 version: number;
 generatedAt: string;
 rows: AgentStateRow[];
}

/** Result of a Message / Stop action. `stale` = the row was no longer live; the caller should resync. */
export interface AgentActionResult {
 ok: boolean;
  stale?: boolean;
  error?: string;
  snapshot?: AgentStateSnapshot;
}

/** IPC channel names. */
export const AGENT_STATE_SNAPSHOT_CHANNEL = 'agents:state-snapshot'; // invoke → AgentStateSnapshot
export const AGENT_STATE_CHANGED_EVENT = 'agents:state-changed'; // main → renderer push, payload AgentStateSnapshot
