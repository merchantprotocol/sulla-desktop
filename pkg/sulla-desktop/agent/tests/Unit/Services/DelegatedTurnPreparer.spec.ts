// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send: vi.fn() }) }));

import { Graph } from '../../../nodes/Graph';
import { DelegatedTurnPreparer } from '../../../services/DelegatedTurnPreparer';

describe('DelegatedTurnPreparer', () => {
  it('makes a reused cycle-complete graph state execute without replacing its messages or identity', async() => {
    // risk: child completion input is queued on the right thread but a stale
    // cycleComplete flag makes the reused graph return without consuming it.
    const executeNode = vi.fn(async(state: any) => ({ state, decision: { type: 'end' as const } }));
    const graph = new Graph<any>()
      .addNode({ id: 'input_handler', name: 'input', execute: executeNode })
      .setEntryPoint('input_handler')
      .setEndPoints('input_handler');
    const messages = [{ role: 'user', content: 'child completed' }];
    const state: any = {
      messages,
      metadata: { cycleComplete: true, waitingForUser: true, iterations: 9, consecutiveSameNode: 4, agentLoopCount: 3 },
    };

    await graph.execute(state);
    expect(executeNode).not.toHaveBeenCalled();

    new DelegatedTurnPreparer().prepare(state);
    await graph.execute(state);

    expect(executeNode).toHaveBeenCalledOnce();
    expect(state.messages).toBe(messages);
    expect(state.metadata.cycleComplete).toBe(false);
  });
});
