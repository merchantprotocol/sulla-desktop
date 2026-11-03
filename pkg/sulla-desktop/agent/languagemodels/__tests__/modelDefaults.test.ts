// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const settings = new Map<string, any>();
const agents = new Map<string, any>();
jest.mock('../../database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: jest.fn((key: string, fallback: any) => Promise.resolve(settings.has(key) ? settings.get(key) : fallback)), set: jest.fn((key: string, value: any) => { settings.set(key, value); return Promise.resolve(value) }) } }));
jest.mock('../../services/AgentDefinitionService', () => ({ agentDefinitionService: { findBySlug: jest.fn((slug: string) => Promise.resolve(agents.get(slug) || null)), list: jest.fn(() => Promise.resolve([...agents.values()])) } }));
jest.mock('../modelRouter', () => ({ modelRouter: { providerInfo: jest.fn(() => Promise.resolve([{ id: 'claude-code' }])), resolve: jest.fn() } }));

import { getModelDefaults, resolveDefaultChoice, setModelDefaults } from '../modelDefaults';

describe('model defaults', () => {
 beforeEach(() => { settings.clear(); agents.clear(); agents.set('heartbeat', { slug: 'heartbeat', name: 'Heartbeat', enabled: true, status: 'production' }) });
 test('ships Heartbeat when enabled and falls back to Sulla when disabled', async() => {
   expect((await getModelDefaults()).heartbeat).toEqual({ kind: 'agent', agentId: 'heartbeat' });
   settings.clear(); agents.get('heartbeat').enabled = false;
   expect((await getModelDefaults()).heartbeat).toEqual({ kind: 'agent', agentId: 'sulla' });
 });
 test('migrates legacy heartbeat tiers to a model class', async() => {
   settings.set('heartbeatProvider', 'claude-code'); settings.set('heartbeatModelId', 'fast');
   expect((await getModelDefaults()).heartbeat).toEqual({ kind: 'model', choice: { mode: 'class', class: 'fast' } });
 });
 test('rejects disabled agents and unknown providers', async() => {
   await expect(setModelDefaults({ chat: { kind: 'agent', agentId: 'missing' } })).rejects.toThrow('exist and be enabled');
   await expect(setModelDefaults({ chat: { kind: 'model', choice: { mode: 'pin', provider: 'missing', model: 'x' } } })).rejects.toThrow('Unknown model provider');
 });
 test('resolves model defaults to Sulla while preserving the choice', async() => {
   const choice = { mode: 'list' as const }; expect((await resolveDefaultChoice({ kind: 'model', choice })).modelChoice).toEqual(choice);
 });
});
