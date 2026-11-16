// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { resolveAgentIdentity } from '../../utils/agentIdentity';
import type { TopLevelConversationRegistry } from './CustodyCallerVerifier';

/** Positive proof that a principal is a registered, non-delegated live chat graph. */
export class GraphRegistryTopLevelConversationRegistry implements TopLevelConversationRegistry {
  async isRegisteredTopLevel(channel:string,threadId:string,agentId:string):Promise<boolean>{
    // Lazy import avoids the GraphRegistry -> tool manifests -> provider cycle.
    const {GraphRegistry}=await import('../../services/GraphRegistry');
    const entry=GraphRegistry.get(threadId);
    if(!entry)return false;
    const metadata=entry.state.metadata as any;
    return String(metadata.threadId??'')===threadId
      && String(metadata.wsChannel??'')===channel
      && resolveAgentIdentity(metadata)===agentId
      && metadata.isSubAgent===false
      && Number(metadata.subAgentDepth??0)===0
      && !String(metadata.managerThreadId??'').trim();
  }
}
