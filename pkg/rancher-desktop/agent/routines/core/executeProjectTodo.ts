/**
 * Visible workflow contract for the deterministic Projects execution owner.
 *
 * TaskDispatcherService owns queue selection, leases, worker execution, and
 * controller settlement.  Lane-entry automation records this workflow as the
 * execution-entry contract, while the dispatcher remains the one data-plane
 * owner.  Keeping the adapter deliberately deterministic prevents a second
 * agent graph from racing the mechanical dispatcher.
 */
import { DEFAULT_CORE_ROUTINE_AGENT_ID } from './defaultCoreAgent';

export const EXECUTE_PROJECT_TODO_ID = 'core-routine-execute-project-todo';

export const EXECUTE_PROJECT_TODO_DEFINITION: Record<string, any> = {
  id:          EXECUTE_PROJECT_TODO_ID,
  name:        'Execute Projects Task',
  description: 'Locked core execution-entry workflow. The mechanical dispatcher owns claims, workers, leases, custody, and the handoff to independent review.',
  version:     2,
  laneContract: {
    input:  'project.lane-entry.v1',
    output: 'project.lane-outcome.v1',
    owner:  'task-dispatcher',
  },
  enabled:   true,
  createdAt: '2026-08-23T19:00:00.000Z',
  updatedAt: '2026-08-30T15:30:00.000Z',
  nodes:     [
    {
      id:       'node-execution-trigger',
      type:     'workflow',
      position: { x: 320, y: 0 },
      data:     {
        label:    'Execution Entry',
        category: 'trigger',
        subtype:  'manual',
        config:   {
          triggerType:        'manual',
          triggerDescription: 'A Projects task entered the configured execution-entry stage.',
        },
      },
    },
    {
      id:       'node-execution-owner',
      type:     'workflow',
      position: { x: 320, y: 180 },
      data:     {
        label:    'Mechanical Dispatcher Owns Execution',
        category: 'agent',
        subtype:  'agent',
        config:   {
          agentId:                  DEFAULT_CORE_ROUTINE_AGENT_ID,
          agentName:                'Projects Execution Admission',
          additionalPrompt:         'Do not execute or mutate the task. TaskDispatcherService is the sole execution owner.',
          successCriteria:          'Confirm the bounded task is admitted to the mechanical dispatcher queue without creating a second dispatch.',
          completionContract:       'Return a terse admission receipt only. Do not call Projects write tools.',
          orchestratorInstructions: 'Read the bounded lane-entry envelope. Return JSON only: {"owner":"task-dispatcher","admitted":true}. Do not execute the task, launch agents, or mutate Projects. Trigger: {{trigger}}',
        },
      },
    },
    {
      id:       'node-execution-admitted',
      type:     'workflow',
      position: { x: 320, y: 360 },
      data:     {
        label:    'Dispatcher Admission Recorded',
        category: 'io',
        subtype:  'response',
        config:   { responseTemplate: 'Execution entry is owned by the mechanical dispatcher.' },
      },
    },
  ],
  edges: [
    { id: 'e-execution-trigger-owner', source: 'node-execution-trigger', target: 'node-execution-owner', animated: true },
    { id: 'e-execution-owner-admitted', source: 'node-execution-owner', target: 'node-execution-admitted', animated: true },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
};
