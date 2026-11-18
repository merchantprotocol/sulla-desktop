// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { DockerWorkflowLauncher } from './launcher.js';

describe('workflow runner Files mount propagation', () => {
  it('passes the stable parent rslave bind when Files is enabled', async() => {
    // risk: availability — a direct FUSE bind leaves active workflow runners on a dead superblock after adapter restart.
    const create = vi.fn(async(_spec:{ binds:string[] }) => 'runner-1');
    const launcher = new DockerWorkflowLauncher({ create } as any, true);

    await launcher.prepareRunner({ executionId: 'execution-1', runToken: 'test-only' });

    expect(create.mock.calls[0]?.[0]?.binds).toContain('/mnt/sulla:/mnt/sulla:rslave');
    expect(create.mock.calls[0]?.[0]?.binds).not.toContain('/mnt/sulla-files:/mnt/sulla-files:rslave');
    expect(create.mock.calls[0]?.[0]?.binds).not.toContain('/mnt/sulla/files:/mnt/sulla/files:rslave');
  });
});
