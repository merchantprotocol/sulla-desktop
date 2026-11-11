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

  async runEach<T>(tasks: Array<{ name: string; work: Promise<T>; apply: (value: T) => void }>, budgetMs: number): Promise<{ dropped: string[]; failures: unknown[] }> {
    const deadline = Date.now() + Math.max(0, budgetMs);
    const completed = new Set<string>();
    const settled = tasks.map(task => task.work.then(value => {
      completed.add(task.name);
      if (Date.now() > deadline) return { name: task.name, dropped: true };
      task.apply(value);
      return { name: task.name, dropped: false };
    }, error => ({ name: task.name, error })));
    const completion = await this.run(Promise.all(settled), budgetMs);
    if (completion.status === 'timeout') return { dropped: tasks.filter(task => !completed.has(task.name)).map(task => task.name), failures: [] };
    return {
      dropped: completion.value.filter((result: any) => result.dropped).map((result: any) => result.name),
      failures: completion.value.filter((result: any) => 'error' in result).map((result: any) => result.error),
    };
  }
}
