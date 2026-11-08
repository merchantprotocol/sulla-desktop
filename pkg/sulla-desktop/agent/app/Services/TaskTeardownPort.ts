// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** A positive, generation-fenced observation from the real execution boundary. */
export type TaskTeardownOutcome = 'confirmed' | 'still-running' | 'unavailable';

/** Stops only the durable execution generation assigned to one task. */
export interface TaskTeardownPort {
  teardown(jobId: string, taskIndex: number): Promise<TaskTeardownOutcome>;
}
