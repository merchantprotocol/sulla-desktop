import { describe, expect, it } from '@jest/globals';
import {
  AbortService,
  combineAborts,
  isAbortSignal,
  throwIfAborted,
} from '../AbortService';

describe('combineAborts', () => {
  it('returns undefined when no sources are present', () => {
    expect(combineAborts()).toBeUndefined();
    expect(combineAborts(undefined, null)).toBeUndefined();
  });

  it('returns the same AbortService when it is the only source', () => {
    const parent = new AbortService();

    expect(combineAborts(parent)).toBe(parent);
    expect(combineAborts(parent, undefined)).toBe(parent);
  });

  it('wraps a lone AbortSignal in an AbortService so throwIfAborted can read .signal', () => {
    const job = new AbortController();
    const combined = combineAborts(undefined, job.signal);

    expect(combined).toBeInstanceOf(AbortService);
    expect(combined?.aborted).toBe(false);

    job.abort();
    expect(combined?.aborted).toBe(true);
  });

  it('does not throw when combining AbortService + AbortSignal (the spawn_agent bug)', () => {
    const parent = new AbortService();
    const job = new AbortController();

    // Regression: AbortSignal.any([parent, job.signal]) threw
    // TypeError: Failed to execute 'any' on 'AbortSignal':
    // Failed to convert value to 'AbortSignal'.
    let combined: AbortService | undefined;

    expect(() => {
      combined = combineAborts(parent, job.signal);
    }).not.toThrow();

    expect(combined).toBeInstanceOf(AbortService);
    expect(combined).not.toBe(parent);
    expect(combined?.aborted).toBe(false);
  });

  it('aborts the combined service when the parent AbortService aborts', () => {
    const parent = new AbortService();
    const job = new AbortController();
    const combined = combineAborts(parent, job.signal);

    parent.abort();
    expect(combined?.aborted).toBe(true);
  });

  it('aborts the combined service when the job signal aborts', () => {
    const parent = new AbortService();
    const job = new AbortController();
    const combined = combineAborts(parent, job.signal);

    job.abort();
    expect(combined?.aborted).toBe(true);
  });

  it('starts already-aborted when a source is already aborted', () => {
    const parent = new AbortService();

    parent.abort();
    const combined = combineAborts(parent, new AbortController().signal);

    expect(combined?.aborted).toBe(true);
  });
});

describe('isAbortSignal', () => {
  it('accepts a real AbortSignal and rejects AbortService', () => {
    expect(isAbortSignal(new AbortController().signal)).toBe(true);
    expect(isAbortSignal(new AbortService())).toBe(false);
    expect(isAbortSignal(undefined)).toBe(false);
    expect(isAbortSignal({})).toBe(false);
  });
});

describe('throwIfAborted', () => {
  it('throws when state.metadata.options.abort is an aborted AbortService', () => {
    const abort = new AbortService();

    abort.abort();
    const state = { metadata: { options: { abort } } };

    expect(() => throwIfAborted(state, 'stopped')).toThrow(/stopped/);
  });

  it('throws when state.metadata.options.abort is an aborted raw AbortSignal (legacy)', () => {
    const ctl = new AbortController();

    ctl.abort();
    const state = { metadata: { options: { abort: ctl.signal } } };

    expect(() => throwIfAborted(state, 'stopped')).toThrow(/stopped/);
  });

  it('does not throw when abort is live', () => {
    const state = { metadata: { options: { abort: new AbortService() } } };

    expect(() => throwIfAborted(state)).not.toThrow();
  });
});
