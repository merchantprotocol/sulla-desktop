// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it } from 'vitest';
import { AgentRunLocationResolver } from './AgentRunLocationResolver';
import { setSullaRuntimeActive } from '@pkg/backend/sullaRuntime/state';
import type { AgentGraphState } from '../nodes/Graph';

const state = (runLocation?: 'vm' | 'container'): AgentGraphState => ({
  metadata: { wsChannel: 'api', threadId: 'thread', agent: runLocation ? { runLocation } : undefined },
} as AgentGraphState);

describe('AgentRunLocationResolver', () => {
  afterEach(() => setSullaRuntimeActive(false));

  it('routes an API owner run to a container on the Sulla runtime without agent run-location metadata', () => {
    // risk: runtime execution environment (CLI and Files mounts)
    setSullaRuntimeActive(true);
    expect(new AgentRunLocationResolver().resolve(state(), 'api')).toBe('container');
  });

  it('keeps VM operator channels on the VM route regardless of configured agent location', () => {
    // risk: preserving privileged operator-channel routing
    expect(new AgentRunLocationResolver(location => location).resolve(state('container'), 'sulla-desktop')).toBe('vm');
    expect(new AgentRunLocationResolver(location => location).resolve(state('container'), 'heartbeat')).toBe('vm');
  });
});
