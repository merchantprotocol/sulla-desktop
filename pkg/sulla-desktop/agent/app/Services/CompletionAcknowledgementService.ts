// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { StrandedEpisodeRepository } from '../Repositories/StrandedEpisodeRepository';
import type { PendingCompletion } from '../../services/AgentCompletionInbox';

export interface TaskCompletionAcknowledger { markTaskCompletionDelivered(jobId: string, taskIndex: number): Promise<void> }
export interface CompletionClaimStore { acknowledge(entry: PendingCompletion): void }

/** Commits durable delivery only after the parent turn consumes an inbox entry. */
export class CompletionAcknowledgementService {
  constructor(private readonly tasks: TaskCompletionAcknowledger, private readonly episodes: StrandedEpisodeRepository,
    private readonly claims: CompletionClaimStore) {}

  async acknowledge(entry: PendingCompletion): Promise<void> {
    if (entry.dedupeKey?.startsWith('stranded:')) await this.episodes.markDelivered(entry.dedupeKey);
    else await this.tasks.markTaskCompletionDelivered(entry.jobId, entry.taskIndex);
    this.claims.acknowledge(entry);
  }
}
