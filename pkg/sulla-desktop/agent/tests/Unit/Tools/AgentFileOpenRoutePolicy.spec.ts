// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { AgentFileOpenRoutePolicy } from '../../../tools/files/AgentFileOpenRoutePolicy';
import { InlineFileReferenceMessageFactory } from '../../../tools/files/InlineFileReferenceMessage';

describe('AgentFileOpenRoutePolicy', () => {
  const policy = new AgentFileOpenRoutePolicy();
  const visibleTrustedContext = {
    threadId: 'thread-a',
    executionThreadId: 'thread-a',
    hasChatTransport: true,
    isDesktopChatVisible: true,
    isSubAgent: false,
    isRelayed: false,
    isChatMuted: false,
    isSubconsciousSilent: false,
  };

  it('routes only the trusted, reportable invocation thread inline and propagates inline failures', () => {
    // risk: tenant isolation
    expect(policy.route(undefined, visibleTrustedContext))
      .toEqual({ kind: 'inline', threadId: 'thread-a', onFailure: 'propagate' });
  });

  it('routes a verified CLI/MCP tool session without a container execution identity inline', () => {
    // risk: policy — in-VM claude-code/codex sessions carry the bound graph state but no executionContext.
    expect(policy.route(undefined, { ...visibleTrustedContext, executionThreadId: undefined }))
      .toEqual({ kind: 'inline', threadId: 'thread-a', onFailure: 'propagate' });
  });

  it('keeps an explicit tab request on the legacy route even with trusted chat context', () => {
    // risk: permission boundary
    expect(policy.route('tab', visibleTrustedContext)).toEqual({ kind: 'legacy-tab', reason: 'requested-tab' });
  });

  it.each([
    ['no originating thread', { ...visibleTrustedContext, threadId: undefined }, 'no-thread'],
    ['no chat transport', { ...visibleTrustedContext, hasChatTransport: false }, 'no-chat-transport'],
    ['no trusted visibility evidence', { ...visibleTrustedContext, isDesktopChatVisible: undefined as unknown as boolean }, 'not-visible-desktop-chat'],
    ['hidden chat despite a transport', { ...visibleTrustedContext, isDesktopChatVisible: false }, 'not-visible-desktop-chat'],
    ['sub-agent', { ...visibleTrustedContext, isSubAgent: true }, 'sub-agent'],
    ['relayed turn', { ...visibleTrustedContext, isRelayed: true }, 'relayed-turn'],
    ['muted worker', { ...visibleTrustedContext, isChatMuted: true }, 'chat-muted'],
    ['subconscious worker', { ...visibleTrustedContext, isSubconsciousSilent: true }, 'chat-muted'],
    ['mismatched execution thread', { ...visibleTrustedContext, executionThreadId: 'thread-b' }, 'thread-mismatch'],
    ['mismatched trusted state thread', { ...visibleTrustedContext, threadId: 'thread-b' }, 'thread-mismatch'],
  ])('uses legacy tab behavior for %s and rejects an explicit inline request', (_name, context, reason) => {
    // risk: hidden-worker isolation
    expect(policy.route(undefined, context)).toEqual({ kind: 'legacy-tab', reason });
    expect(policy.route('inline', context)).toMatchObject({ kind: 'reject', reason, message: expect.stringContaining('Inline file cards need a visible Desktop chat; this call came from') });
  });

  it('does not accept a user-supplied thread id in placement options as routing context', () => {
    // risk: tenant isolation
    const userOptions = { placement: 'inline' as const, threadId: 'attacker-thread' };
    expect(policy.route(userOptions.placement, visibleTrustedContext))
      .toEqual({ kind: 'inline', threadId: 'thread-a', onFailure: 'propagate' });
  });

  it('rejects an unknown placement without choosing a presentation route', () => {
    // risk: permission boundary
    expect(policy.route('active-window', visibleTrustedContext)).toMatchObject({ kind: 'reject', reason: 'invalid-placement' });
  });
});

describe('InlineFileReferenceMessageFactory', () => {
  const factory = new InlineFileReferenceMessageFactory();

  it('keeps a non-shared system record with only call identity and reference IDs', () => {
    // risk: unauthorized file disclosure
    const input = {
      threadId: 'thread-a',
      toolCallId: 'call-a',
      fileId: 'file-a',
      collectionId: 'collection-a',
      bytes: 'synthetic-private-content',
      capability: 'synthetic-capability',
      deniedMetadata: 'synthetic-denial-detail',
    };
    expect(factory.create(input)).toEqual({
      role: 'system',
      content: '',
      thread_id: 'thread-a',
      tool_call_id: 'call-a',
      reference: { file_id: 'file-a', collection_id: 'collection-a' },
    });
  });

  it('rejects incomplete reference identities instead of emitting an unresolvable message', () => {
    // risk: authorization boundary
    expect(() => factory.create({
      threadId: 'thread-a',
      toolCallId: 'call-a',
      fileId: '',
      collectionId: 'collection-a',
    })).toThrow('thread, tool-call, file, and collection identities are required');
  });
});
