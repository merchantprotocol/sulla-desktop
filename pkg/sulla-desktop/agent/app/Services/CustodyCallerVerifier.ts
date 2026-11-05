// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { resolveAgentIdentity, type AgentIdentityMetadata } from '../../utils/agentIdentity';
import type { JobTaskLocator } from './JobTaskLocator';

const VERIFIED_ACTOR_TOKEN = Symbol('verified-custody-actor');

type VerifiedActorToken = typeof VERIFIED_ACTOR_TOKEN;
export type CustodyActorScope = 'delegated' | 'top-level';

/** Runtime-authenticated custody principal. Tool arguments can never construct one. */
export class VerifiedCustodyActor {
  readonly #verified = true;

  constructor(
    readonly kind: 'agent' | 'human',
    readonly channel: string,
    readonly threadId: string,
    readonly agentId: string,
    readonly scope: CustodyActorScope,
    token: VerifiedActorToken,
  ) {
    if (token !== VERIFIED_ACTOR_TOKEN) throw new Error('Custody actors must be verified from runtime caller context.');
  }

  assertVerified(): void { if (!this.#verified) throw new Error('Unverified custody actor.'); }

  /** Reserved for a future direct UI/IPC adapter. Agent tools must never call this factory. */
  static humanForUiIpc(): VerifiedCustodyActor {
    return new VerifiedCustodyActor('human', '', '', '', 'top-level', VERIFIED_ACTOR_TOKEN);
  }

}

export interface CustodyRuntimeCallerContext extends AgentIdentityMetadata {
  threadId?: string;
  subAgentDepth?: unknown;
  managerThreadId?: unknown;
}

export interface TopLevelConversationRegistry {
  isRegisteredTopLevel(channel: string, threadId: string, agentId: string): Promise<boolean>;
}

/** Converts runtime-injected metadata—not tool arguments—into a custody principal. */
export class CustodyCallerVerifier {
  constructor(
    private readonly taskLocator: Pick<JobTaskLocator, 'findTaskByThread'>,
    private readonly conversations: TopLevelConversationRegistry,
  ) {}

  async verify(context: CustodyRuntimeCallerContext | null | undefined): Promise<VerifiedCustodyActor> {
    const channel = String(context?.wsChannel ?? '').trim();
    const threadId = String(context?.threadId ?? '').trim();
    const agentId = resolveAgentIdentity(context);
    const positivelyTopLevel = Boolean(channel && threadId && agentId)
      && Number(context?.subAgentDepth ?? 0) === 0
      && !String(context?.managerThreadId ?? '').trim()
      && !await this.taskLocator.findTaskByThread(threadId)
      && await this.conversations.isRegisteredTopLevel(channel, threadId, agentId);
    return new VerifiedCustodyActor('agent', channel, threadId, agentId, positivelyTopLevel ? 'top-level' : 'delegated', VERIFIED_ACTOR_TOKEN);
  }
}
