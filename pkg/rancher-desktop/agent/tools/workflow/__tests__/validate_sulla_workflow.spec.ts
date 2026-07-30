import { validateWorkflowDefinition } from '../validate_sulla_workflow';

import { getWorkflowSchedulerService } from '@pkg/agent/services/WorkflowSchedulerService';
import { SCHEDULE_TRIGGER } from '@pkg/pages/editor/workflow/types';

function makeDefinition(triggerNode: any) {
  return {
    id:    'workflow-test',
    name:  'Test Workflow',
    nodes: [
      triggerNode,
      {
        id:       'node-2',
        type:     'workflow',
        position: { x: 0, y: 120 },
        data:     {
          category: 'agent',
          subtype:  'orchestrator-prompt',
          label:    'Do the thing',
          config:   { prompt: 'do it' },
        },
      },
    ],
    edges: [{ id: 'edge-1', source: 'node-1', target: 'node-2' }],
  };
}

function errors(def: any) {
  return validateWorkflowDefinition(def).filter(i => i.severity === 'error');
}

describe('validateWorkflowDefinition', () => {
  it('accepts the schedule trigger shape the runtime scheduler arms (#493)', () => {
    // Exact shape of a production routine's weekly schedule trigger —
    // category/subtype from the constant WorkflowSchedulerService filters on.
    const def = makeDefinition({
      id:       'node-1',
      type:     'workflow',
      position: { x: 0, y: 0 },
      data:     {
        category: SCHEDULE_TRIGGER.category,
        subtype:  SCHEDULE_TRIGGER.subtype,
        label:    'Weekly Sunday 6pm Trigger',
        config:   {
          triggerType:        'schedule',
          triggerDescription: 'Weekly audit, Sundays 18:00 PT.',
          frequency:          'weekly',
          hour:               18,
          minute:             0,
          dayOfWeek:          0,
          timezone:           'America/Los_Angeles',
        },
      },
    });

    expect(errors(def)).toEqual([]);
  });

  it('accepts a manual trigger', () => {
    const def = makeDefinition({
      id:       'node-1',
      type:     'workflow',
      position: { x: 0, y: 0 },
      data:     {
        category: 'trigger',
        subtype:  'manual',
        label:    'Manual Trigger',
        config:   { triggerType: 'manual', triggerDescription: 'Run on demand' },
      },
    });

    expect(errors(def)).toEqual([]);
  });

  it('still rejects a bogus subtype', () => {
    const def = makeDefinition({
      id:       'node-1',
      type:     'workflow',
      position: { x: 0, y: 0 },
      data:     {
        category: 'trigger',
        subtype:  'cron',
        label:    'Bad Trigger',
        config:   { triggerType: 'cron', triggerDescription: 'nope' },
      },
    });

    expect(errors(def).some(e => e.message.includes('Invalid subtype "cron"'))).toBe(true);
  });

  it('still rejects unknown config fields on a schedule trigger', () => {
    const def = makeDefinition({
      id:       'node-1',
      type:     'workflow',
      position: { x: 0, y: 0 },
      data:     {
        category: 'trigger',
        subtype:  'schedule',
        label:    'Schedule Trigger',
        config:   {
          triggerType:        'schedule',
          triggerDescription: 'desc',
          cronExpression:     '0 18 * * 0',
        },
      },
    });

    expect(errors(def).some(e => e.path.endsWith('/config/cronExpression'))).toBe(true);
  });

  it('validates the same trigger shape the scheduler service arms', () => {
    // Importing the service here also makes ts-jest type-check
    // WorkflowSchedulerService.ts, which consumes SCHEDULE_TRIGGER.
    expect(typeof getWorkflowSchedulerService).toBe('function');
    expect(SCHEDULE_TRIGGER).toEqual({ category: 'trigger', subtype: 'schedule' });
  });

  it('requires triggerType/triggerDescription on schedule triggers', () => {
    const def = makeDefinition({
      id:       'node-1',
      type:     'workflow',
      position: { x: 0, y: 0 },
      data:     {
        category: 'trigger',
        subtype:  'schedule',
        label:    'Schedule Trigger',
        config:   { frequency: 'daily' },
      },
    });

    const errs = errors(def);

    expect(errs.some(e => e.path.endsWith('/config/triggerType'))).toBe(true);
    expect(errs.some(e => e.path.endsWith('/config/triggerDescription'))).toBe(true);
  });
});
