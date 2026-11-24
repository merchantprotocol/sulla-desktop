// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ref } from 'vue';

import { createMessageDispatcher } from '@pkg/agent/database/models/MessageDispatcher';
import { PersonaAdapter } from '@pkg/pages/chat/services/PersonaAdapter';

const threadId = 'thread-inline-file';
const file = { file_id: 'file-1', collection_id: 'collection-1', tool_call_id: 'call-1', thread_id: threadId };

function context() {
  return {
    messages: [] as any[], graphRunning: ref(false), waitingForUser: ref(false), stopReason: ref<string | null>(null), currentActivity: ref(''),
    registry: { setLoading() {} }, toolRunIdToMessageId: new Map(), speakListeners: [],
    setThreadId() {}, getThreadId: () => threadId, handleTokenInfo() {}, removeAsset() {},
  } as any;
}

function dispatch(ctx: any, data: any, thread = threadId) {
  createMessageDispatcher().dispatch(ctx, 'agent-1', thread, { type: 'assistant_message', data } as any);
}

describe('inline file reference dispatch', () => {
  it('creates one record, preserves idle graph state, and skips redelivery', () => {
    // risk: idempotency — websocket redelivery must not duplicate a visible file card or alter run state.
    const ctx = context();
    dispatch(ctx, { kind: 'inline_file_reference', inlineFileReference: file });
    dispatch(ctx, { kind: 'inline_file_reference', inlineFileReference: file });
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]).toMatchObject({ id: `inline-file:agent-1:${threadId}:call-1`, kind: 'inline_file_reference' });
    expect(ctx.graphRunning.value).toBe(false);
  });

  it('keeps distinct tool calls as distinct records for the same file', () => {
    // risk: data accuracy — each agent open has a fresh tool call and needs its own card.
    const ctx = context();
    dispatch(ctx, { kind: 'inline_file_reference', inlineFileReference: file });
    dispatch(ctx, { kind: 'inline_file_reference', inlineFileReference: { ...file, tool_call_id: 'call-2' } });
    expect(ctx.messages.map((message: any) => message.id)).toEqual([
      `inline-file:agent-1:${threadId}:call-1`, `inline-file:agent-1:${threadId}:call-2`,
    ]);
  });

  it('drops thread-mismatched and incomplete references', () => {
    // risk: tenant/thread isolation — malformed or cross-thread references must never enter the transcript.
    const ctx = context();
    dispatch(ctx, { kind: 'inline_file_reference', inlineFileReference: { ...file, thread_id: 'other-thread' } });
    dispatch(ctx, { kind: 'inline_file_reference', inlineFileReference: { ...file, file_id: '' } });
    dispatch(ctx, { kind: 'inline_file_reference' });
    expect(ctx.messages).toHaveLength(0);
  });

  it('maps a persisted backend record to the typed InlineFileReferenceMessage', () => {
    // risk: persistence accuracy — rehydrated cards must retain the file identity used by renderer IPC.
    const adapter = Object.create(PersonaAdapter.prototype) as any;
    adapter.firstSeenAt = new Map();
    const mapped = adapter.mapBackendMessage({ id: 'inline-record-1', kind: 'inline_file_reference', role: 'assistant', content: '', inlineFileReference: file });
    expect(mapped).toMatchObject({ kind: 'inline_file_reference', fileId: 'file-1', collectionId: 'collection-1', toolCallId: 'call-1', threadId });
  });
});
