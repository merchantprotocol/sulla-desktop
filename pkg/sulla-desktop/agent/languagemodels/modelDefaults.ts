// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { agentDefinitionService } from '../services/AgentDefinitionService';
import { resolveRoutableAgent } from '../services/ChatAgentRouting';
import { modelRouter } from './modelRouter';
import { MODEL_CLASSES, type AgentModelChoice } from './modelRoutingTypes';
import type { ModelDefaultChoice, ModelDefaults } from './modelDefaultsTypes';

const SETTING = 'modelDefaults';
const tiers: Record<string, AgentModelChoice> = { fast: { mode: 'class', class: 'fast' }, balanced: { mode: 'class', class: 'standard' }, powerful: { mode: 'class', class: 'frontier' } };

async function shipped(): Promise<ModelDefaults> {
 const heartbeat = await resolveRoutableAgent('heartbeat');
 return { chat: { kind: 'agent', agentId: 'sulla' }, heartbeat: { kind: 'agent', agentId: heartbeat ? 'heartbeat' : 'sulla' } };
}

function validChoice(value: any): value is AgentModelChoice {
 return value?.mode === 'list' || (value?.mode === 'class' && MODEL_CLASSES.includes(value.class)) || (value?.mode === 'pin' && typeof value.provider === 'string' && !!value.provider && typeof value.model === 'string' && !!value.model);
}

export async function validateModelDefault(value: unknown): Promise<ModelDefaultChoice> {
 const choice = value as ModelDefaultChoice;
 if (choice?.kind === 'agent') {
   if (typeof choice.agentId !== 'string' || !await resolveRoutableAgent(choice.agentId)) throw new Error('Default agent must exist and be enabled');
   return choice;
 }
 if (choice?.kind === 'model' && validChoice(choice.choice)) {
   if (choice.choice.mode === 'pin' && !(await modelRouter.providerInfo()).some(p => p.id === choice.choice.provider)) throw new Error('Unknown model provider');
   return choice;
 }
 throw new Error('Invalid model default');
}

export async function getModelDefaults(): Promise<ModelDefaults> {
 const saved = await SullaSettingsModel.get(SETTING, null);
 if (saved?.chat && saved?.heartbeat) return saved as ModelDefaults;
 const defaults = await shipped();
 const provider = await SullaSettingsModel.get('heartbeatProvider', 'default');
 const model = await SullaSettingsModel.get('heartbeatModelId', 'default');
 if (provider && provider !== 'default') defaults.heartbeat = { kind: 'model', choice: tiers[model] || { mode: 'pin', provider, model: model && model !== 'default' ? model : provider } };
 await SullaSettingsModel.set(SETTING, defaults, 'json');
 return defaults;
}

export async function setModelDefaults(patch: Partial<ModelDefaults>): Promise<ModelDefaults> {
 const current = await getModelDefaults();
 const next = { chat: patch.chat ? await validateModelDefault(patch.chat) : current.chat, heartbeat: patch.heartbeat ? await validateModelDefault(patch.heartbeat) : current.heartbeat };
 await SullaSettingsModel.set(SETTING, next, 'json');
 return next;
}

export async function resetModelDefaults(): Promise<ModelDefaults> {
 const value = await shipped(); await SullaSettingsModel.set(SETTING, value, 'json'); return value;
}

export async function enabledDefaultAgents() {
 const definitions = (await agentDefinitionService.list()).filter(a => a.enabled && a.status !== 'archive').map(a => ({ slug: a.slug, name: a.name, whenToCall: a.when_to_call || a.description, enabled: true }));
 return [{ slug: 'sulla', name: 'Sulla', whenToCall: 'Your everyday assistant: answers directly and hands work to the right specialist', enabled: true }, ...definitions.filter(a => a.slug !== 'sulla')];
}

export async function resolveDefaultChoice(value: ModelDefaultChoice) {
 if (value.kind === 'agent') return { agent: await resolveRoutableAgent(value.agentId) || await resolveRoutableAgent('sulla'), modelChoice: undefined };
 return { agent: await resolveRoutableAgent('sulla'), modelChoice: value.choice };
}
