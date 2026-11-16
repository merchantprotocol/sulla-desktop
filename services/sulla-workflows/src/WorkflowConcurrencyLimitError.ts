// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * A new run was refused because the workflow already has its maximum number of
 * active executions. This is an expected admission outcome, not a fault: callers
 * report it as "skipped" (or HTTP 409) instead of logging an error stack.
 */
export class WorkflowConcurrencyLimitError extends Error {
  readonly limit: number;
  readonly activeExecutionIds: string[];

  constructor(limit: number, activeExecutionIds: string[]) {
    super(`Workflow has reached its ${ limit } concurrent run limit; active executions: ${ activeExecutionIds.join(', ') }.`);
    this.name = 'WorkflowConcurrencyLimitError';
    this.limit = limit;
    this.activeExecutionIds = activeExecutionIds;
  }
}
