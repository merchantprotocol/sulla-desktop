// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/ActiveAgentsRegistry', () => ({
  getActiveAgentsRegistry: () => ({
    buildCompactRoster: async() => 'Jonathon (human): Busy · idle 0m\nagents: Heartbeat@heartbeat (running, 309m) | Coding Manager@coding-manager (running, 0m)',
  }),
}));

import { buildTurnContext } from '../../../prompts/turnContext';

describe('per-turn context header', () => {
  it('keeps runtime and roster context without agent or channel fields', async() => {
    // risk: misleading agent/channel attribution in every model turn
    const context = await buildTurnContext({ chatMode: 'text', isHeartbeat: false });
    const runtimeLine = context.split('\n')[1];

    expect(runtimeLine).toMatch(/^now="[^"]+" tz=\S+$/);
    expect(context).not.toMatch(/(?:^|\s)(?:agent|channel)=/m);
    expect(context).toContain('Jonathon (human): Busy · idle 0m');
    expect(context).toContain('agents: Heartbeat@heartbeat (running, 309m) | Coding Manager@coding-manager (running, 0m)');
  });
});
