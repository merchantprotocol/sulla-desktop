/**
 * Process-wide record of workflow executions that still have an in-process
 * writer (a sub-agent whose stop has not been confirmed). Orphan recovery
 * treats membership as writer evidence, so a child that outlives its parent's
 * lease keeps its reservation. The registry is in memory on purpose: an app
 * restart ends every in-process child, so an empty registry after restart is
 * the truth, and external children are tracked through agent_jobs instead.
 */
const liveWriters = new Map<string, number>();

export const LiveWriterRegistry = {
  acquire(executionId: string): void {
    liveWriters.set(executionId, (liveWriters.get(executionId) ?? 0) + 1);
  },

  release(executionId: string): void {
    const left = (liveWriters.get(executionId) ?? 1) - 1;
    if (left > 0) liveWriters.set(executionId, left);
    else liveWriters.delete(executionId);
  },

  executionIds(): string[] {
    return [...liveWriters.keys()];
  },
};
