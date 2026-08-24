import { describe, expect, it } from '@jest/globals';
import { resolveRoleForStatus } from '../WorkLaneDefinitionModel';

describe('resolveRoleForStatus (issue #711)', () => {
  it('maps built-in statuses to their semantic roles', () => {
    expect(resolveRoleForStatus('backlog')).toBe('backlog');
    expect(resolveRoleForStatus('todo')).toBe('execution');
    expect(resolveRoleForStatus('planning')).toBe('planning');
    expect(resolveRoleForStatus('in_progress')).toBe('execution');
    expect(resolveRoleForStatus('in_review')).toBe('review');
    expect(resolveRoleForStatus('blocked')).toBe('blocked');
    expect(resolveRoleForStatus('done')).toBe('terminal');
    expect(resolveRoleForStatus('cancelled')).toBe('terminal');
    expect(resolveRoleForStatus('parked')).toBe('manual');
  });

  it('prefers a custom lane semantic_role over the default map', () => {
    expect(resolveRoleForStatus('todo', [{ lane_key: 'todo', semantic_role: 'planning' }])).toBe('planning');
    expect(resolveRoleForStatus('qa_gate', [{ lane_key: 'qa_gate', semantic_role: 'review' }])).toBe('review');
  });

  it('ignores non-matching lanes and defaults unknown statuses to execution', () => {
    expect(resolveRoleForStatus('mystery', [{ lane_key: 'other', semantic_role: 'review' }])).toBe('execution');
    expect(resolveRoleForStatus('mystery')).toBe('execution');
  });
});
