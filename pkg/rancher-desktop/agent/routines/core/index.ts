/**
 * Core routines — locked, baked-in routines distributed with Sulla Desktop.
 *
 * Every definition listed here is re-asserted into the `workflows` table on
 * boot by seedCoreRoutines(), marked system = true. They are visible and
 * runnable and may be disabled by the human, but cannot be edited or deleted
 * through any user-facing surface (enforced in WorkflowModel + the workflow
 * tools). Deleting a row from the DB self-heals on the next launch.
 *
 * To add a new core routine: author its WorkflowDefinition as a TS module in
 * this directory and add it to CORE_ROUTINES below.
 */

import { DREAM_ABOUT_HUMAN_DEFINITION } from './dreamAboutHuman';
import { REVIEW_PROJECT_ARTIFACT_DEFINITION } from './reviewProjectArtifact';
import { PLAN_PROJECT_TASK_DEFINITION } from './planProjectTask';
import { EXECUTE_PROJECT_TODO_DEFINITION } from './executeProjectTodo';
import { DEFAULT_CORE_ROUTINE_AGENT_ID } from './defaultCoreAgent';

export const CORE_ROUTINES: readonly Record<string, any>[] = [
  DREAM_ABOUT_HUMAN_DEFINITION,
  REVIEW_PROJECT_ARTIFACT_DEFINITION,
  PLAN_PROJECT_TASK_DEFINITION,
  EXECUTE_PROJECT_TODO_DEFINITION,
];

for (const routine of CORE_ROUTINES) {
  const customAgentNode = routine.nodes?.find((node: any) =>
    node.data?.subtype === 'agent' && node.data?.config?.agentId !== DEFAULT_CORE_ROUTINE_AGENT_ID,
  );
  if (customAgentNode) {
    throw new Error(
      `Locked core routine ${ routine.id } node ${ customAgentNode.id } must use ${ DEFAULT_CORE_ROUTINE_AGENT_ID }`,
    );
  }
}
