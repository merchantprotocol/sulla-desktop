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
import { EXECUTE_PROJECT_TODO_DEFINITION } from './executeProjectTodo';
import { PLAN_PROJECT_TASK_DEFINITION } from './planProjectTask';

export const CORE_ROUTINES: ReadonlyArray<Record<string, any>> = [
  DREAM_ABOUT_HUMAN_DEFINITION,
  PLAN_PROJECT_TASK_DEFINITION,
  EXECUTE_PROJECT_TODO_DEFINITION,
];
