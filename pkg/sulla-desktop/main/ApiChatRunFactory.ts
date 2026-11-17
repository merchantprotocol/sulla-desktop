// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentGraphState, BaseThreadState } from '@pkg/agent/nodes/Graph';

export class OwnerIdentityUnavailableError extends Error {
  constructor() { super('owner identity unavailable'); }
}

export interface ApiChatSession {
  revoke(): void;
}

type OwnerBoundKey = 'userId' | 'ownerUserId' | 'isTrustedUser';
type OwnerBoundMetadata = Record<OwnerBoundKey, unknown>;

const OWNER_BOUND_KEYS: readonly OwnerBoundKey[] = ['userId', 'ownerUserId', 'isTrustedUser'];

/**
 * Binds owner identity onto a persistent graph's metadata and restores the exact
 * prior state (including absent keys) so later requests on the same thread_id
 * cannot inherit trust or identity.
 */
export class OwnerMetadataBinding {
  private readonly target: OwnerBoundMetadata;
  private readonly snapshot: ReadonlyArray<{ key: OwnerBoundKey; present: boolean; value: unknown }>;

  constructor(metadata: BaseThreadState['metadata']) {
    this.target = metadata as unknown as OwnerBoundMetadata;
    this.snapshot = OWNER_BOUND_KEYS.map((key) => ({
      key,
      present: Object.prototype.hasOwnProperty.call(this.target, key),
      value:   this.target[key],
    }));
  }

  bind(userId: string): void {
    this.target.userId = userId;
    this.target.ownerUserId = userId;
    this.target.isTrustedUser = 'trusted';
  }

  restore(): void {
    for (const { key, present, value } of this.snapshot) {
      if (present) {
        this.target[key] = value;
      } else {
        delete this.target[key];
      }
    }
  }
}

/** Temporarily binds an explicitly owner-authorized API run to the local user. */
export class ApiChatRunFactory {
  constructor(
    private readonly ownerUserId: () => Promise<string>,
    private readonly registerSession: (state: BaseThreadState) => ApiChatSession,
    private readonly runOwnerRuntime: <T>(state: AgentGraphState, operation: () => Promise<T>) => Promise<T> = (_state, operation) => operation(),
  ) {}

  async run<T>(state: AgentGraphState, runAsOwner: boolean, operation: () => Promise<T>): Promise<T> {
    if (!runAsOwner) return operation();
    const userId = await this.ownerUserId();
    if (!userId) throw new OwnerIdentityUnavailableError();

    const binding = new OwnerMetadataBinding(state.metadata);
    let session: ApiChatSession | undefined;
    try {
      binding.bind(userId);
      session = this.registerSession(state);
      return await this.runOwnerRuntime(state, operation);
    } finally {
      try {
        session?.revoke();
      } finally {
        binding.restore();
      }
    }
  }
}
