import { describe, expect, it } from '@jest/globals';

import { validateWorkflowDefinition } from '../../tools/workflow/validate_sulla_workflow';
const definition = {
  id: 'browser-test',
name: 'Browser test',
description: 'Scoped browser',
version: 1,
  createdAt: '2026-01-01T00:00:00Z',
updatedAt: '2026-01-01T00:00:00Z',
  nodes: [{ id: 'start', type: 'workflow', position: { x: 0, y: 0 }, data: { category: 'trigger', subtype: 'manual', label: 'Start', config: { triggerType: 'manual', triggerDescription: 'Test' } } }],
edges: [],
};
describe('routine browser schema', () => {
  it.each([true, false])('accepts explicit boolean %p', browser => {
    expect(validateWorkflowDefinition({ ...definition, browser }).filter(i => i.path === '/browser')).toEqual([]);
  });
  it.each(['true', 1, {}, null])('rejects malformed grant %p', browser => {
    expect(validateWorkflowDefinition({ ...definition, browser }).filter(i => i.path === '/browser')).toHaveLength(1);
  });
});
