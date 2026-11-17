// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { BaseThreadState } from '@pkg/agent/nodes/Graph';

export class OwnerIdentityUnavailableError extends Error {
  constructor() { super('owner identity unavailable'); }
}

export interface ApiChatSession {
  revoke(): void;
}

/** Temporarily binds an explicitly owner-authorized API run to the local user. */
export class ApiChatRunFactory {
  constructor(
    private readonly ownerUserId: () => Promise<string>,
    private readonly registerSession: (state: BaseThreadState) => ApiChatSession,
  ) {}

  async run<T>(state: BaseThreadState, runAsOwner: boolean, operation: () => Promise<T>): Promise<T> {
    if (!runAsOwner) return operation();
    const userId = await this.ownerUserId();
    if (!userId) throw new OwnerIdentityUnavailableError();

    const metadata = state.metadata as typeof state.metadata & { userId?: string; ownerUserId?: string };
    metadata.userId = userId;
    metadata.ownerUserId = userId;
    state.metadata.isTrustedUser = 'trusted';
    const session = this.registerSession(state);
    try {
      return await operation();
    } finally {
      session.revoke();
    }
  }
}
