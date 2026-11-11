// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { GitPushWorker } from '../../../../tools/github/git_push';
import { runCommand } from '../../../../tools/util/CommandRunner';

vi.mock('../../../../tools/util/CommandRunner', () => ({ runCommand: vi.fn() }));
vi.mock('../../../../../vault-broker', () => ({ usesContainerVaultAuthority: () => true }));
vi.mock('../../../../services/IntegrationService', () => ({ getIntegrationService: vi.fn() }));

describe('GitPushWorker missing context', () => {
  it('fails closed before executing git when broker context is absent', async() => {
    // risk: credential scope — a contextless worker must not attempt ambient Git auth.
    const result = await (new GitPushWorker() as any)._validatedCall({ absolutePath: '/workspace/repo' });
    expect(result.successBoolean).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
  });
});
