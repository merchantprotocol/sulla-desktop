// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { BaseThreadState } from './Graph';
import type { BaseLanguageModel } from '../languagemodels/BaseLanguageModel';
import type { ModelCandidate } from '../languagemodels/modelRouter';

interface TurnProvider { userMessage: unknown; provider: BaseLanguageModel; candidates: ModelCandidate[] }

/** Keeps resolved providers off serialized graph metadata and scopes them to a user-message turn. */
export class TurnProviderMemo {
  private readonly turns = new WeakMap<BaseThreadState, TurnProvider>();

  get(state: BaseThreadState): TurnProvider | undefined {
    const userMessage = [...state.messages].reverse().find(message => message.role === 'user');
    const turn = this.turns.get(state);
    return turn && turn.userMessage === userMessage ? turn : undefined;
  }

  set(state: BaseThreadState, provider: BaseLanguageModel, candidates: ModelCandidate[]): void {
    const userMessage = [...state.messages].reverse().find(message => message.role === 'user');
    this.turns.set(state, { userMessage, provider, candidates: [...candidates] });
  }
}

export const turnProviderMemo = new TurnProviderMemo();
