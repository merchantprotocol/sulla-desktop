import { describe, it, expect, beforeEach } from '@jest/globals';

import { runThroughWriterGate, _resetWriterGateForTests, _writerGateStateForTests } from '../SubconsciousWriterGate';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolveOuter!: (v: T) => void;
  const promise = new Promise<T>((resolve) => { resolveOuter = resolve });
  return { promise, resolve: resolveOuter };
}

describe('SubconsciousWriterGate', () => {
  beforeEach(() => {
    _resetWriterGateForTests();
  });

  it('runs up to the concurrency cap immediately', async() => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: number[] = [];

    const runs = gates.map((g, i) => runThroughWriterGate(async() => {
      started.push(i);
      await g.promise;
    }));

    // Let microtasks flush so all three acquire() calls resolve.
    await Promise.resolve();
    await Promise.resolve();

    expect(started.sort()).toEqual([0, 1, 2]);
    expect(_writerGateStateForTests().active).toBe(3);

    gates.forEach(g => g.resolve());
    await Promise.all(runs);
  });

  it('queues work beyond the concurrency cap instead of running it immediately', async() => {
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const started: number[] = [];

    const runs = gates.map((g, i) => runThroughWriterGate(async() => {
      started.push(i);
      await g.promise;
    }));

    await Promise.resolve();
    await Promise.resolve();

    // Only the first 3 (the cap) should have started; 2 are queued.
    expect(started.length).toBe(3);
    expect(_writerGateStateForTests().active).toBe(3);
    expect(_writerGateStateForTests().waiting).toBe(2);

    // Freeing one slot lets the next queued task start. Give the resolve ->
    // await g.promise -> finally{release()} -> next() -> acquire() chain
    // enough microtask ticks to fully unwind.
    gates[0].resolve();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(started.length).toBe(4);

    gates.slice(1).forEach(g => g.resolve());
    await Promise.all(runs);
    expect(started.length).toBe(5);
    expect(_writerGateStateForTests()).toEqual({ active: 0, waiting: 0 });
  });

  it('releases the slot even when the wrapped work throws', async() => {
    await expect(runThroughWriterGate(() => {
      throw new Error('writer failed');
    })).rejects.toThrow('writer failed');

    expect(_writerGateStateForTests()).toEqual({ active: 0, waiting: 0 });

    // The freed slot is usable immediately afterward.
    let ran = false;
    await runThroughWriterGate(() => { ran = true; return Promise.resolve() });
    expect(ran).toBe(true);
  });

  it('returns the resolved value of the wrapped work', async() => {
    const result = await runThroughWriterGate(() => Promise.resolve(42));
    expect(result).toBe(42);
  });
});
