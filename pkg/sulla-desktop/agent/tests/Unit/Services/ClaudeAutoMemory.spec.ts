// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import '../../Support/TestHomeEnv';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ default: { app: { getVersion: () => 'test' } } }));

import { ClaudeCodeService } from '../../../languagemodels/ClaudeCodeService';

describe('Claude Code auto-memory setting', () => {
  // risk: agents may otherwise write private memory outside Sulla's memory systems
  it('disables auto-memory in both VM and container spawn commands', () => {
    const service = new ClaudeCodeService() as any;
    const vmCommand = service.buildSpawnArgs({
      oauthToken: '', apiKey: '', mcpConfigPath: null, disallowedTools: '', scopedSupport: false,
      pidFile: '/tmp/claude-auto-memory.pid',
    }).join(' ');
    const containerCommand = service.buildProviderCommand({
      mcpConfigPath: null, disallowedTools: '', scopedSupport: false,
      environment: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', SULLA_TOOL_SESSION: 'fixture-session' },
    });

    expect(vmCommand).toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
    expect(containerCommand.env).toMatchObject({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      SULLA_TOOL_SESSION: 'fixture-session',
    });
  });
});
