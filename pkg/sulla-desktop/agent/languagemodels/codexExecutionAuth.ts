// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { usesContainerVaultAuthority, type ProviderCliBridgeLease } from '../../vault-broker';
import { getPendingCredential } from '../../main/firstRun/pendingCredentials';
import { ensureCodexAuthFile, extractChatgptAccountId } from '../util/codexAuthFile';
import { createGuestCodexBrokerLease } from './codexGuestBrokerLease';
import { createCodexPendingMemoryBridge } from './codexPendingMemoryBridge';
import { AuthExpired, RoutingUnavailable, VaultLocked } from './failures';

import type { BaseThreadState } from '../nodes/Graph';

export type CodexExecutionAuthKind = 'guest-auth-file' | 'container-broker-lease' | 'pending-memory-bridge';

/**
 * How a guest `codex exec` gets authenticated for this spawn — chosen and
 * validated before the process starts, never discovered mid-run. Exactly one
 * of GuestAuthFile (legacy custody; ~/.codex/auth.json, nothing to export
 * here), ContainerBrokerLease (vault authority; opaque bridge) or
 * PendingMemoryBridge (first run; opaque bridge) applies to a given spawn.
 */
export interface CodexExecutionAuth {
  readonly kind: CodexExecutionAuthKind;
  /** Exported into the guest shell before `exec codex …`. Empty for guest-auth-file. */
  readonly environment: Readonly<Record<string, string>>;
  /** Appended as `-c <override>` codex CLI args. Empty for guest-auth-file. */
  readonly codexConfigOverrides: readonly string[];
  /** Releases the bridge lease, if any. Safe to call more than once. */
  dispose(): void;
}

const NO_BRIDGE_AUTH: CodexExecutionAuth = Object.freeze({
  kind:                 'guest-auth-file',
  environment:          Object.freeze({}),
  codexConfigOverrides: Object.freeze([]),
  dispose() { /* nothing to release */ },
});

function fromLease(kind: 'container-broker-lease' | 'pending-memory-bridge', lease: ProviderCliBridgeLease): CodexExecutionAuth {
  let disposed = false;
  return {
    kind,
    environment:          lease.config.environment,
    codexConfigOverrides: lease.config.codexConfigOverrides ?? [],
    dispose() {
      if (disposed) return;
      disposed = true;
      lease.revoke();
      lease.close().catch(() => { /* already closing */ });
    },
  };
}

/**
 * Resolve exactly one execution auth for a Codex spawn. Never returns a
 * value that lets the caller spawn without a validated credential path —
 * every failure here is a typed ProviderFailure instead of a generic Error,
 * so it reaches the user as a specific, actionable message instead of a late
 * opaque CLI crash.
 */
export async function resolveCodexExecutionAuth(input: {
  conversationId: string;
  state?:         BaseThreadState;
}): Promise<CodexExecutionAuth> {
  const pending = getPendingCredential('codex');
  if (pending?.values.access_token) {
    const idToken = typeof pending.values.id_token === 'string' ? pending.values.id_token : undefined;
    const chatgptAccountId = extractChatgptAccountId(idToken);
    if (!chatgptAccountId) {
      throw new RoutingUnavailable('codex', { cause: new Error('First-run Codex sign-in has no ChatGPT account routing claim') });
    }
    try {
      const lease = await createCodexPendingMemoryBridge({ accessToken: pending.values.access_token, chatgptAccountId }, input);
      return fromLease('pending-memory-bridge', lease);
    } catch (err) {
      throw new AuthExpired('codex', { cause: err });
    }
  }

  if (usesContainerVaultAuthority()) {
    try {
      const lease = await createGuestCodexBrokerLease(input);
      return fromLease('container-broker-lease', lease);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/routing claim/i.test(message)) throw new RoutingUnavailable('codex', { cause: err });
      throw new VaultLocked('codex', { cause: err });
    }
  }

  const ok = await ensureCodexAuthFile();
  if (!ok) {
    throw new AuthExpired('codex', { cause: new Error('No Codex credentials configured. Sign in with ChatGPT via Integrations → OpenAI Codex.') });
  }
  return NO_BRIDGE_AUTH;
}
