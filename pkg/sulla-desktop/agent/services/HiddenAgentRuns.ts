// SPDX-License-Identifier: GPL-2.0-or-later
/** Tracks complete runner lifetimes, including asynchronous settlement cleanup. */
export class HiddenAgentRuns {
  private static readonly runs = new Set<Promise<unknown>>();
  static track<T>(run: Promise<T>): Promise<T> {
    this.runs.add(run);
    run.finally(() => this.runs.delete(run)).catch(() => undefined);
    return run;
  }

  static async settle(): Promise<void> { await Promise.allSettled([...this.runs]) }
}
export function trackHiddenAgentRun<T>(run: Promise<T>): Promise<T> { return HiddenAgentRuns.track(run) }
export async function settleHiddenAgentRuns(): Promise<void> { await HiddenAgentRuns.settle() }
