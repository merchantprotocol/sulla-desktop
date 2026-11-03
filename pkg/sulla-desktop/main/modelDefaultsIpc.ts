// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcMain } from 'electron';
import { enabledDefaultAgents, getModelDefaults, resetModelDefaults, resolveDefaultChoice, setModelDefaults } from '../agent/languagemodels/modelDefaults';
import { MODEL_DEFAULTS_IPC, type ModelDefaultChoice } from '../agent/languagemodels/modelDefaultsTypes';
import { modelRouter } from '../agent/languagemodels/modelRouter';

async function resolvedLabel(value: ModelDefaultChoice): Promise<string> {
 const resolved = await resolveDefaultChoice(value);
 const agent = resolved.agent?.name || 'Sulla';
 const choice = resolved.modelChoice || { mode: 'list' as const };
 const candidate = (await modelRouter.resolve('agents', choice))[0];
 const source = choice.mode === 'list' ? 'Agents list' : choice.mode === 'class' ? `Class: ${choice.class}` : 'a pinned model';
 return `→ ${agent} · uses ${source}${candidate ? ` → ${candidate.model} via ${candidate.provider}` : ''}`;
}

async function state() {
 const defaults = await getModelDefaults();
 return { defaults, agents: await enabledDefaultAgents(), resolved: { chat: await resolvedLabel(defaults.chat), heartbeat: await resolvedLabel(defaults.heartbeat) } };
}

export function initModelDefaultsIpc(): void {
 for (const channel of Object.values(MODEL_DEFAULTS_IPC)) ipcMain.removeHandler(channel);
 ipcMain.handle(MODEL_DEFAULTS_IPC.get, state);
 ipcMain.handle(MODEL_DEFAULTS_IPC.set, async(_event, patch) => { await setModelDefaults(patch || {}); return state() });
 ipcMain.handle(MODEL_DEFAULTS_IPC.reset, async() => { await resetModelDefaults(); return state() });
}
