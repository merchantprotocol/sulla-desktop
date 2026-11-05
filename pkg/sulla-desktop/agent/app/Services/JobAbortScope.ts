// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service } from '@sulla/foundation';

/** Owns the independent cancellation boundaries for one delegated job. */
export class JobAbortScope extends Service {
  private readonly jobController = new AbortController();
  private readonly taskControllers = new Map<number, AbortController>();

  taskSignal(taskIndex: number): AbortSignal {
    let controller = this.taskControllers.get(taskIndex);
    if (!controller) {
      controller = new AbortController();
      this.taskControllers.set(taskIndex, controller);
      if (this.jobController.signal.aborted) controller.abort();
    }
    return controller.signal;
  }

  abortTask(taskIndex: number): void { this.taskControllers.get(taskIndex)?.abort(); }
  abortJob(): void {
    this.jobController.abort();
    for (const controller of this.taskControllers.values()) controller.abort();
  }
}
