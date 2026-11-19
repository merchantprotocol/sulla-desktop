// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { AgentReadinessStatus } from '@pkg/shared/agentReadinessStatus';

const id = 'readiness-00000000-0000-4000-8000-000000000001';
describe('transient readiness messages', () => {
  it('updates one wait, clears it on resume and preserves other chats and ordinary messages', () => {
    const messages = [
      { id: 'legacy', channelId: 'chat', threadId: 'one', role: 'assistant', kind: 'progress', content: 'Waiting for Password Vault. Work will continue when it is ready.' },
      { id: 'other', channelId: 'chat', threadId: 'two', role: 'assistant', kind: 'progress', content: 'Waiting for Password Vault. Work will continue when it is ready.' },
      { id: 'answer', channelId: 'chat', threadId: 'one', role: 'assistant', content: 'An ordinary answer' },
    ];
    AgentReadinessStatus.apply(messages, 'chat', 'one', { readinessWaitId: id, readinessState: 'waiting', content: 'Connecting' });
    AgentReadinessStatus.apply(messages, 'chat', 'one', { readinessWaitId: id, readinessState: 'waiting', content: 'Retrying' });
    expect(messages.filter(message => message.id === id)).toHaveLength(1);
    expect(messages.find(message => message.id === id)?.content).toBe('Retrying');
    AgentReadinessStatus.apply(messages, 'chat', 'one', { readinessWaitId: id, readinessState: 'resumed' });
    expect(messages.filter(message => !(message as any).readinessCleared).map(message => message.id)).toEqual(['other', 'answer']);
  });
  it('publishes recovery after a delayed waiting delivery and differentiates connection from locked', async() => {
    const messages: { content: string; state: string }[] = [];
    await AgentReadinessStatus.wait(async(_signal, waiting) => { await Promise.resolve(); waiting('Password Vault'); waiting('vault unlock') }, undefined,
      async(content, status) => { await Promise.resolve(); messages.push({ content, state: status.readinessState }) });
    expect(messages.map(message => message.state)).toEqual(['waiting', 'waiting', 'resumed']);
    expect(messages[0].content).toContain('does not mean the vault is locked');
    expect(messages[1].content).toContain('is locked');
  });
  it('clears a cancelled check without claiming recovery or suppressing the abort', async() => {
    const states: string[] = [];
    await expect(AgentReadinessStatus.wait(async(_signal, waiting) => { await Promise.resolve(); waiting('Password Vault'); throw Object.assign(new Error(), { name: 'AbortError' }) }, undefined,
      async(_content, status) => { await Promise.resolve(); states.push(status.readinessState) })).rejects.toMatchObject({ name: 'AbortError' });
    expect(states).toEqual(['waiting', 'cancelled']);
  });
  it('clears through the real dispatcher without reopening a completed chat', async() => {
    const { createMessageDispatcher } = await import('../../../database/models/MessageDispatcher');
    const ctx = { messages: [], graphRunning: { value: false } } as any;
    const dispatcher = createMessageDispatcher();
    dispatcher.dispatch(ctx, 'chat', 'one', { type: 'assistant_message', data: { readinessWaitId: id, readinessState: 'waiting', content: 'Connecting' } } as any);
    expect(ctx.messages).toHaveLength(1); expect(ctx.graphRunning.value).toBe(false);
    dispatcher.dispatch(ctx, 'chat', 'one', { type: 'assistant_message', data: { readinessWaitId: id, readinessState: 'resumed', content: '' } } as any);
    expect(ctx.messages[0].readinessCleared).toBe(true); expect(ctx.graphRunning.value).toBe(false);
  });
});
