// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Bound how long startup waits for an OPTIONAL subsystem.
 *
 * Returns as soon as `work` settles, or after `budgetMs` with `timedOut: true`
 * (the work keeps running in the background; a late failure is logged once, never
 * thrown). A failure that happens inside the budget is rethrown to the caller.
 */
export type BudgetOutcome<T> = { timedOut: false; value: T } | { timedOut: true };

export async function awaitWithBudget<T>(label: string, work: Promise<T>, budgetMs: number): Promise<BudgetOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
  });

  try {
    const outcome = await Promise.race([work.then(value => ({ timedOut: false as const, value })), budget]);

    if (outcome.timedOut) {
      console.warn(`[Startup] ${ label } is still running after ${ budgetMs } ms; continuing startup while it finishes in the background`);
      work.catch(error => console.warn(`[Startup] ${ label } failed after the startup budget:`, error));
    }

    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
