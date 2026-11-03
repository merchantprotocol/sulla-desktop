// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, test } from 'vitest';
import type { ModelRoutingState } from '@pkg/agent/languagemodels/modelRoutingTypes';
import { modelsForProvider, moveItem, orderedClassModels, traceRoute } from './routingLogic';

const state: ModelRoutingState = { agentsList: [{ provider: 'a', class: 'fast', enabled: false }, { provider: 'b', class: 'fast', enabled: true }], subconsciousList: [], classes: { frontier: [], standard: [], fast: [{ provider: 'b', model: 'quick' }, { provider: 'a', model: 'swift' }], coding: [], local: [] }, followProviderOrder: { frontier: true, standard: true, fast: true, coding: true, local: true }, providers: [{ id: 'a', name: 'A', connected: true, local: false, subscription: false, status: 'ready', coolingUntil: null, lastError: null, models: [] }, { id: 'b', name: 'B', connected: true, local: false, subscription: false, status: 'ready', coolingUntil: null, lastError: null, models: [] }] };
describe('model routing logic', () => { test('reorders immutably', () => expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1])); test('filters classes by provider', () => expect(modelsForProvider(state, state.providers[0])).toEqual(['fast'])); test('follows provider order', () => expect(orderedClassModels(state, 'fast').map(x => x.provider)).toEqual(['a', 'b'])); test('traces skips then first ready', () => expect(traceRoute(state, 'agents').map(x => x.result)).toEqual(['off', 'use'])); });
