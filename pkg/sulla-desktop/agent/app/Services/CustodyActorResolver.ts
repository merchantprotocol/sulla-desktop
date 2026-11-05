// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { resolveAgentIdentity } from '../../utils/agentIdentity';
import type { CustodyActor, CustodyOwner } from './JobCustodyTypes';

export interface CustodyCaller { actor: CustodyActor; owner?: CustodyOwner }
export class CustodyActorResolver {
  resolve(metadata: Record<string, any>|undefined): CustodyCaller {
    const channel=String(metadata?.wsChannel??'').trim();
    const threadId=String(metadata?.threadId??'').trim();
    const agentId=resolveAgentIdentity(metadata);
    const owner=channel&&threadId&&agentId?{channel,threadId,agentId}:undefined;
    const delegated=Number(metadata?.subAgentDepth)>0 || Boolean(metadata?.managerThreadId);
    return {actor:delegated&&owner?{kind:'agent',...owner}:{kind:'human'},owner};
  }
}
