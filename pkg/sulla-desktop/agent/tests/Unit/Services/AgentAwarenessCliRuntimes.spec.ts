// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

vi.mock('@pkg/agent/database/RedisClient', () => ({
  redisClient: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') },
}));

import { ClaudeCodeService } from '@pkg/agent/languagemodels/ClaudeCodeService';
import { CodexService } from '@pkg/agent/languagemodels/CodexService';

describe('Claude Code and Codex runtime context', () => {
  it('filters agent-network boilerplate from both CLI prompts only when awareness is off', async() => {
    // risk: CLI-managed workers receive prompt copies that bypass the graph's awareness gate.
    const state = { metadata: { threadId: 'worker-thread', agentId: 'codex-luna-worker', agentAwareness: false } } as any;
    const claude = new ClaudeCodeService() as any;
    const codex = new CodexService() as any;
    const claudeOff = await claude.buildUserMessageContextPrefix(state, { convId: 'claude-off', isNewSession: false });
    const codexOff = (await codex.buildUserMessageContextPrefix(state, { convId: 'codex-off', isNewSession: false })).prefix;
    for (const prefix of [claudeOff, codexOff]) {
      expect(prefix).not.toContain('live multi-agent network');
      expect(prefix).not.toContain('Sub-agent and workflow-worker runs are NOT woken');
      expect(prefix).toContain('Sulla Desktop');
    }

    const awareState = { metadata: { threadId: 'manager-thread', agentId: 'coding-manager', agentAwareness: true } } as any;
    const claudeOn = await claude.buildUserMessageContextPrefix(awareState, { convId: 'claude-on', isNewSession: false });
    const codexOn = (await codex.buildUserMessageContextPrefix(awareState, { convId: 'codex-on', isNewSession: false })).prefix;
    expect(claudeOn).toContain('live multi-agent network');
    expect(codexOn).toContain('live multi-agent network');
  });
});
