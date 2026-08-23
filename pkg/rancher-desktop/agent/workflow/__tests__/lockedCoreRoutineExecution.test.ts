import {
  lockedCoreBlockedError,
  resolveAgentTaskForDispatch,
} from '../lockedCoreRoutineExecution';

describe('locked core routine execution policy', () => {
  it('uses the baked task verbatim instead of an orchestrator refusal', () => {
    const bakedTask = '  Archive only clear duplicate human observations.  ';
    const refusal = 'I cannot act on unverified personal data.';

    expect(resolveAgentTaskForDispatch(true, bakedTask, refusal))
      .toBe('Archive only clear duplicate human observations.');
  });

  it('keeps orchestrator formulation for ordinary editable workflows', () => {
    expect(resolveAgentTaskForDispatch(false, 'configured', 'formulated'))
      .toBe('formulated');
  });

  it('turns a blocked locked-core child into a terminal failure reason', () => {
    expect(lockedCoreBlockedError(true, 'Prune Stale Observations', 'tools unavailable'))
      .toBe('Locked core routine node "Prune Stale Observations" blocked: tools unavailable');
    expect(lockedCoreBlockedError(false, 'Interactive Step', 'need user choice')).toBeNull();
  });
});
