// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type RecallBudgetResult<T> = { status: 'completed'; value: T } | { status: 'timeout' };

/** Applies a deadline to read-only recall work; callers decide whether to merge its isolated result. */
export class PreModelRecallBudget {
  async run<T>(work: Promise<T>, budgetMs: number): Promise<RecallBudgetResult<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work.then(value => ({ status: 'completed' as const, value })),
        new Promise<{ status: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ status: 'timeout' }), Math.max(0, budgetMs)) }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
