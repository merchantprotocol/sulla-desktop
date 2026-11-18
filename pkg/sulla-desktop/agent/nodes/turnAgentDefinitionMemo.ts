// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { BaseThreadState } from './Graph';

interface TurnDefinition<T> { userMessage: unknown; agentId: string; promise: Promise<T> }

/** Deduplicates agent-definition reads for all stages that share a graph turn. */
export class TurnAgentDefinitionMemo<T> {
  private readonly turns = new WeakMap<BaseThreadState, TurnDefinition<T>>();

  get(state: BaseThreadState, agentId: string, load: () => Promise<T>): Promise<T> {
    const userMessage = [...state.messages].reverse().find(message => message.role === 'user');
    const current = this.turns.get(state);
    if (current && current.userMessage === userMessage && current.agentId === agentId) return current.promise;
    const promise = load();
    this.turns.set(state, { userMessage, agentId, promise });
    return promise;
  }
}

export const turnAgentDefinitionMemo = new TurnAgentDefinitionMemo<any>();
