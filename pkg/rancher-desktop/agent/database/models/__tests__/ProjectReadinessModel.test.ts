import { classifyHumanGate } from '../ProjectReadinessModel';

describe('ProjectReadinessModel human-gate classifier', () => {
  it.each([
    { assignee: 'human', labels: [] },
    { assignee: null, labels: ['gated'] },
    { assignee: null, labels: ['manual'] },
    { assignee: null, labels: ['no-auto-dispatch'] },
  ])('recognizes an explicit human gate: %#', task => {
    expect(classifyHumanGate(task)).toMatchObject({ type: 'human_gate' });
  });

  it('does not turn an ordinary autonomous task into a human gate', () => {
    expect(classifyHumanGate({ assignee: 'dispatcher', labels: ['backend'] })).toBeNull();
  });
});
