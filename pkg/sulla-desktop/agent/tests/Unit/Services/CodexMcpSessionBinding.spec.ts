// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { bindCodexMcpSession } from '../../../languagemodels/codexMcpConfig';
import type { AgentContainerRuntimeBinding } from '../../../services/AgentContainerRuntimeRegistry';

describe('Codex MCP session binding', () => {
  it('forwards the worker runtime binding explicitly when registering outside ambient scope', () => {
    // risk: cross-job credential scope
    const binding: AgentContainerRuntimeBinding = {
      podId: 'pod-worker', subject: 'user', agentId: 'worker', jobId: 'job-worker',
      deviceId: 'device', workspacePath: '/workspace',
    };
    const registered = { id: 'session', url: 'http://host/mcp', header: 'Bearer session', revoke: vi.fn() };
    const registerSession = vi.fn(() => registered);
    const session = bindCodexMcpSession({ running: true, registerSession, rebindSession: vi.fn() } as any, { metadata: {} } as any, null, binding);
    expect(session).toBe(registered);
    expect(registerSession).toHaveBeenCalledWith(expect.anything(), expect.any(Number), binding);
  });
});
