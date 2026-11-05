// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { CustodyOwner } from './JobCustodyTypes';

export interface LeadReplacementLaunchInput {
  oldJobId: string; oldTaskIndex: number; agentId: string; model?: string; provider?: string;
  prompt: string; owner: CustodyOwner;
}
export interface LeadReplacementLaunch { jobId: string; taskIndex: number; threadId: string }
export interface LeadTaskExecutionPort { launchReplacement(input: LeadReplacementLaunchInput): Promise<LeadReplacementLaunch> }
