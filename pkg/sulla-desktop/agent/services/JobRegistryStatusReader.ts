// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentJobStatusReader } from './AgentContainerRetentionPolicy';

/** The read-only slice of the job registry's public API this reader needs. */
export interface AgentJobLookup {
  getJob(jobId: string): Promise<{ status: string } | undefined | null>;
}

/** Reads an owning job's status for container retention; an unreadable status is reported as unknown. */
export class JobRegistryStatusReader implements AgentJobStatusReader {
  constructor(private readonly jobs: AgentJobLookup) {}

  async status(jobId: string): Promise<string | undefined> {
    try {
      return (await this.jobs.getJob(jobId))?.status;
    } catch {
      return undefined;
    }
  }
}
