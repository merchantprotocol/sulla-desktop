import {
  inheritSubAgentToolPolicy,
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

  it('keeps protected reviewer children inside the parent read-only tool policy', () => {
    const parent = {
      llmTools: [{ function: { name: 'read_file' } }],
      metadata: { allowedToolNames: ['read_file'], verifierReadOnly: true },
    };
    const child = { metadata: {} } as any;

    inheritSubAgentToolPolicy(parent, child, { inheritParentToolPolicy: true });

    expect(child.metadata.allowedToolNames).toEqual(['read_file']);
    expect(child.metadata.verifierReadOnly).toBe(true);
    expect(child.llmTools).toEqual(parent.llmTools);
  });

  it('does not change ordinary workflow child tool policy', () => {
    const child = { metadata: { allowedToolNames: ['git_push'] } } as any;
    inheritSubAgentToolPolicy(
      { metadata: { allowedToolNames: ['read_file'], verifierReadOnly: true } },
      child,
      {},
    );
    expect(child.metadata.allowedToolNames).toEqual(['git_push']);
    expect(child.metadata.verifierReadOnly).toBeUndefined();
  });
});
