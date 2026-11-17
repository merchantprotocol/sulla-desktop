// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { ApiChatRunFactory, OwnerIdentityUnavailableError } from './ApiChatRunFactory';
import type { AgentGraphState } from '@pkg/agent/nodes/Graph';

const state = (): AgentGraphState => ({ metadata: { threadId: 'thread', wsChannel: 'api' } } as AgentGraphState);

describe('ApiChatRunFactory', () => {
  it('leaves an unopted-in API run unchanged and creates no tool session', async () => {
    // risk: preserving the API's untrusted-by-default security boundary
    const owner = vi.fn(async () => 'local-owner');
    const register = vi.fn();
    const run = vi.fn(async () => 'ok');
    const graph = state();
    Object.assign(graph.metadata, { userId: 'attacker-user', ownerUserId: 'attacker-owner', sub: 'attacker-sub' });

    await expect(new ApiChatRunFactory(owner, register).run(graph, false, run)).resolves.toBe('ok');
    expect(graph.metadata).toMatchObject({ threadId: 'thread', wsChannel: 'api' });
    expect(graph.metadata.isTrustedUser).toBeUndefined();
    expect(owner).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('binds identity only from the injected local owner and revokes the graph session after execution', async () => {
    // risk: preventing request-controlled identity from authorizing private data access
    const revoke = vi.fn();
    const graph = state();
    let seen: Record<string, unknown> = {};
    const run = vi.fn(async () => {
      seen = { ...graph.metadata };
      return 'done';
    });
    const factory = new ApiChatRunFactory(async () => 'local-owner', () => ({ revoke }));

    await expect(factory.run(graph, true, run)).resolves.toBe('done');
    expect(seen).toMatchObject({ userId: 'local-owner', ownerUserId: 'local-owner', isTrustedUser: 'trusted', threadId: 'thread' });
    expect(graph.metadata).toMatchObject({ threadId: 'thread', wsChannel: 'api' });
    expect('userId' in graph.metadata).toBe(false);
    expect('ownerUserId' in graph.metadata).toBe(false);
    expect('isTrustedUser' in graph.metadata).toBe(false);
    expect(run).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('requests the owner runtime only for trusted API runs', async () => {
    // risk: keeping container CLI and owner Files access behind explicit owner authorization
    const runtime = vi.fn(async (_state: AgentGraphState, operation: () => Promise<string>) => operation());
    const register = vi.fn(() => ({ revoke: vi.fn() }));
    const factory = new ApiChatRunFactory(async () => 'local-owner', register, runtime);
    const run = vi.fn(async () => 'done');

    await factory.run(state(), true, run);
    await factory.run(state(), false, run);

    expect(runtime).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('refuses an owner run when no local identity is available', async () => {
    // risk: preventing fallback to untrusted or attacker-supplied identity
    const register = vi.fn();
    const run = vi.fn();
    await expect(new ApiChatRunFactory(async () => '', register).run(state(), true, run)).rejects.toBeInstanceOf(OwnerIdentityUnavailableError);
    expect(register).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('revokes the graph session when execution throws', async () => {
    // risk: preventing stale owner-authorized tool sessions from surviving failed runs
    const revoke = vi.fn();
    const failure = new Error('execution failed');
    const run = vi.fn(async () => { throw failure; });
    await expect(new ApiChatRunFactory(async () => 'local-owner', () => ({ revoke })).run(state(), true, run)).rejects.toBe(failure);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('restores prior metadata after an opt-in run, deleting keys that were absent', async () => {
    // risk: preventing a persistent graph from keeping owner trust for a later untrusted request on the same thread_id
    const graph = state();
    Object.assign(graph.metadata, { isTrustedUser: 'untrusted' });
    const factory = new ApiChatRunFactory(async () => 'local-owner', () => ({ revoke: vi.fn() }));

    await factory.run(graph, true, async () => 'done');

    expect(graph.metadata.isTrustedUser).toBe('untrusted');
    expect('userId' in graph.metadata).toBe(false);
    expect('ownerUserId' in graph.metadata).toBe(false);
    expect(graph.metadata).toMatchObject({ threadId: 'thread', wsChannel: 'api' });
  });

  it('restores prior metadata when execution throws', async () => {
    // risk: preventing owner trust from leaking onto a persistent graph after a failed run
    const graph = state();
    Object.assign(graph.metadata, { isTrustedUser: 'untrusted', userId: 'prior-user' });
    const failure = new Error('execution failed');
    const factory = new ApiChatRunFactory(async () => 'local-owner', () => ({ revoke: vi.fn() }));

    await expect(factory.run(graph, true, async () => { throw failure; })).rejects.toBe(failure);

    expect(graph.metadata.isTrustedUser).toBe('untrusted');
    expect(graph.metadata.userId).toBe('prior-user');
    expect('ownerUserId' in graph.metadata).toBe(false);
  });

  it('leaves metadata unchanged and skips the operation when registerSession throws', async () => {
    // risk: preventing a half-bound graph from running owner work without a revocable session
    const graph = state();
    Object.assign(graph.metadata, { isTrustedUser: 'untrusted' });
    const before = { ...graph.metadata };
    const failure = new Error('session registration failed');
    const run = vi.fn(async () => 'should not run');
    const factory = new ApiChatRunFactory(async () => 'local-owner', () => { throw failure; });

    await expect(factory.run(graph, true, run)).rejects.toBe(failure);

    expect(graph.metadata).toEqual(before);
    expect('userId' in graph.metadata).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
