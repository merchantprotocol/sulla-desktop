// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobRepository } from '../Repositories/AgentJobRepository';
import type { CompletionInboxPort } from '../../services/AgentCompletionInbox';
import type { CustodyAuditRecord,CustodyChangeNotifier } from './JobCustodyTypes';

export class CustodyChangeNotificationService implements CustodyChangeNotifier {
  constructor(_jobs:AgentJobRepository,private readonly inbox:Pick<CompletionInboxPort,'move'>){}
  async changed(change:CustodyAuditRecord):Promise<void>{
    // Durable OLD/NEW owner notices are inserted in the same transaction as
    // the custody row. This post-commit adapter only redirects legacy
    // in-memory completions so it cannot create a second owner notice.
    this.inbox.move(change.from.channel,change.from.threadId,change.to.channel,change.to.threadId,change.jobId,change.taskIndex);
  }
}
