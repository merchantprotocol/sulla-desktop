/**
 * Visible workflow contract for the deterministic Projects execution owner.
 *
 * TaskDispatcherService owns queue selection, leases, worker execution, and
 * controller settlement.  Lane-entry automation records this workflow as the
 * execution-entry contract, while the dispatcher remains the one data-plane
 * owner.  Keeping the adapter deliberately deterministic prevents a second
 * agent graph from racing the mechanical dispatcher.
 */

export const EXECUTE_PROJECT_TODO_ID = 'core-routine-execute-project-todo';

export const EXECUTE_PROJECT_TODO_DEFINITION: Record<string, any> = {
  id:          EXECUTE_PROJECT_TODO_ID,
  name:        'Execute Projects Task',
  description: 'Locked core execution-entry workflow. The mechanical dispatcher owns claims, workers, leases, custody, and the handoff to independent review.',
  version:     3,
  laneContract: {
    input:  'project.lane-entry.v1',
    output: 'project.lane-outcome.v1',
    owner:  'task-dispatcher',
  },
  enabled:   true,
  createdAt: '2026-08-23T19:00:00.000Z',
  updatedAt: '2026-10-06T00:30:00.000Z',
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
      id:       'node-execution-admitted',
      type:     'workflow',
      position: { x: 320, y: 180 },
      data:     {
        label:    'Mechanical Execution Owner',
        category: 'io',
        subtype:  'response',
        config:   { responseTemplate: 'TaskDispatcherService is the sole execution owner. Lane-entry admission is recorded by code; this workflow does not claim or dispatch tasks.' },
      },
    },
  ],
  edges: [
    { id: 'e-execution-trigger-admitted', source: 'node-execution-trigger', target: 'node-execution-admitted', animated: true },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
};
