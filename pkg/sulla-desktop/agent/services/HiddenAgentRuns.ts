// SPDX-License-Identifier: GPL-2.0-or-later
/** Tracks complete runner lifetimes, including asynchronous settlement cleanup. */
export class HiddenAgentRuns {
  private readonly runs = new Set<Promise<unknown>>();
  private readonly runnersByThread = new Map<string, Promise<unknown>>();

  track<T>(run: Promise<T>, threadId?: string): Promise<T> {
    this.runs.add(run);
    if (threadId) this.runnersByThread.set(threadId, run);
    run.finally(() => {
      this.runs.delete(run);
      if (threadId && this.runnersByThread.get(threadId) === run) this.runnersByThread.delete(threadId);
    }).catch(() => undefined);
    return run;
  }

  async waitForThread(threadId: string): Promise<void> {
    const run = this.runnersByThread.get(threadId);
    if (run) await Promise.allSettled([run]);
  }

  async settle(): Promise<void> { await Promise.allSettled([...this.runs]) }
}

export const hiddenAgentRuns = new HiddenAgentRuns();
export function trackHiddenAgentRun<T>(run: Promise<T>, threadId?: string): Promise<T> { return hiddenAgentRuns.track(run, threadId) }
export async function settleHiddenAgentRuns(): Promise<void> { await hiddenAgentRuns.settle() }
