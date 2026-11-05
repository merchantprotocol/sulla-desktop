// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

export interface AgentLaunchPauseState { on: boolean; since?: number }

/** Durable, process-independent gate for launches and restart recovery. */
export class AgentLaunchPauseService {
  private readonly key = 'agentsKillAllSwitch';

  async state(): Promise<AgentLaunchPauseState> {
    let value: any = null;
    try { value = await SullaSettingsModel.getSetting(this.key, null); } catch { return { on: false }; }
    return value?.on === true ? { on: true, since: Number(value.since) || undefined } : { on: false };
  }

  async isPaused(): Promise<boolean> { return (await this.state()).on; }

  async set(on: boolean): Promise<AgentLaunchPauseState> {
    const value: AgentLaunchPauseState = on ? { on: true, since: Date.now() } : { on: false };
    await SullaSettingsModel.setSetting(this.key, value, 'json');
    return value;
  }
}

export const agentLaunchPauseService = new AgentLaunchPauseService();
