// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * What the liveness reconciler last saw of each container agent's process
 * (it probes every 30s). The window uses it to tell a quiet agent that is
 * still running from one that has stopped; it never changes a task's
 * lifecycle. A reading older than `freshForMs` counts as unknown.
 */
export class AgentRuntimeLiveness {
  private readonly seen = new Map<string, { alive: boolean; at: number }>();

  constructor(private readonly now: () => number = Date.now, private readonly freshForMs = 2 * 60_000) {}

  record(threadId: string | undefined, alive: boolean | undefined): void {
    if (!threadId) return;
    if (alive === undefined) this.seen.delete(threadId);
    else this.seen.set(threadId, { alive, at: this.now() });
  }

  /** True or false from a recent probe; null when there is no recent reading. */
  alive(threadId: string | undefined | null): boolean | null {
    const reading = threadId ? this.seen.get(threadId) : undefined;
    return reading && this.now() - reading.at <= this.freshForMs ? reading.alive : null;
  }
}
