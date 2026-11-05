// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentJobMessagingModel } from '../../database/models/AgentJobMessagingModel';
import type { JobCheckinWriter } from './PersistentContainerAuditor';

/** Production check-in writer: the same job record report_progress appends to. */
export class JobMessagingCheckinWriter implements JobCheckinWriter {
  appendCheckin(threadId: string, input: { step: string; summary: string; filesTouched?: string[]; blockers?: string[] }): Promise<unknown> {
    return AgentJobMessagingModel.appendCheckin(threadId, { filesTouched: [], blockers: [], ...input });
  }
}
