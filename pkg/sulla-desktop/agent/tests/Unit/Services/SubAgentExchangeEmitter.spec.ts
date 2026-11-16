// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send }) }));
import { SubAgentExchangeEmitter, type SubAgentExchangePayload } from '../../../app/Services/SubAgentExchangeEmitter';
import { emitSubAgentExchange } from '../../../tools/agents/jobExchange';

const exchange: SubAgentExchangePayload = {
  direction: 'from_agent', agentId: 'worker', label: 'Build', summary: 'done it', detail: 'full detail', status: 'done', jobId: 'job-1', taskIndex: 0,
};

describe('SubAgentExchangeEmitter', () => {
  it('sends one UI-only chat_message to the parent channel and thread', async() => {
    // risk: sub-agent transcript lands in the wrong chat or loses its payload
    const transport = { send: vi.fn().mockResolvedValue(undefined) };
    await new SubAgentExchangeEmitter(() => transport, { warn: vi.fn() }).emit('sulla-desktop', 'thread-1', exchange);
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledWith('sulla-desktop', {
      type: 'chat_message',
      data: { kind: 'sub_agent_exchange', role: 'assistant', content: 'done it', threadId: 'thread-1', subAgentExchange: exchange },
    });
  });

  it('sends nothing without a parent channel or thread', async() => {
    // risk: orphan exchanges broadcast with no thread
    const transport = { send: vi.fn() };
    const emitter = new SubAgentExchangeEmitter(() => transport, { warn: vi.fn() });
    await emitter.emit(undefined, 'thread-1', exchange);
    await emitter.emit('sulla-desktop', undefined, exchange);
    await emitter.emit('', '', exchange);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('swallows and logs a transport failure instead of throwing into the job path', async() => {
    // risk: a UI websocket error fails a worker's return_result or stop
    const warn = vi.fn();
    const transport = { send: vi.fn().mockRejectedValue(new Error('socket down')) };
    await expect(new SubAgentExchangeEmitter(() => transport, { warn }).emit('c', 't', exchange)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[subAgentExchange] emit failed:', expect.any(Error));
  });

  it('keeps the deprecated emitSubAgentExchange working through the bound provider', async() => {
    // risk: existing callers (stop_agent_job, return_result, spawn_agent) silently stop emitting
    send.mockReset();
    send.mockResolvedValue(undefined);
    await emitSubAgentExchange('sulla-desktop', 'thread-9', exchange);
    expect(send).toHaveBeenCalledWith('sulla-desktop', expect.objectContaining({ type: 'chat_message', data: expect.objectContaining({ threadId: 'thread-9' }) }));
  });
});
