// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { ProviderBridgeLeasePool } from '../../../services/ProviderBridgeLeasePool';

import type { ProviderName } from '../../../languagemodels/ProviderExecutionTransport';

function poolFor(runModel: string | null = 'claude-opus-5-5') {
  const create = vi.fn(async(provider: ProviderName, pinnedModel: string | undefined) => ({ provider, pinnedModel }) as any);
  const pool = new ProviderBridgeLeasePool({
    runProvider: 'claude-code',
    runModel,
    // Stand-in for cliPinnedModelId: a concrete id pins itself, empty means CLI default.
    pinFor:      (_provider, model) => model?.trim() || undefined,
    create,
  });
  return { pool, create };
}

describe('ProviderBridgeLeasePool', () => {
  it('pins the job bridge to the job model and reuses it across turns', async() => {
    // risk: model-scope bypass or a new bridge per turn
    const { pool, create } = poolFor();
    const first = await pool.lease('claude-code');
    const again = await pool.lease('claude-code', 'claude-opus-5-5');
    expect(first).toBe(again);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith('claude-code', 'claude-opus-5-5');
  });

  it('gives a graph launched on another model its own lease pinned to that model', async() => {
    // risk: observers on the light model denied (provider_model_denied) by the job's pinned bridge
    const { pool, create } = poolFor();
    const job = await pool.lease('claude-code');
    const observer = await pool.lease('claude-code', 'claude-haiku-5-5');
    expect(observer).not.toBe(job);
    expect(create).toHaveBeenNthCalledWith(2, 'claude-code', 'claude-haiku-5-5');
    expect(pool.all()).toHaveLength(2);
  });

  it('leaves a CLI-default launch and another provider unpinned', async() => {
    // risk: pinning a model the CLI never requests denies every call
    const { pool, create } = poolFor();
    await pool.lease('claude-code', '');
    await pool.lease('codex');
    expect(create).toHaveBeenNthCalledWith(1, 'claude-code', undefined);
    expect(create).toHaveBeenNthCalledWith(2, 'codex', undefined);
  });

  it('forgets a failed lease so the next call can mint a fresh one', async() => {
    // risk: one transient mint failure poisoning the whole job
    const { pool, create } = poolFor();
    create.mockRejectedValueOnce(new Error('vault starting'));
    await expect(pool.lease('claude-code')).rejects.toThrow('vault starting');
    await expect(pool.lease('claude-code')).resolves.toMatchObject({ pinnedModel: 'claude-opus-5-5' });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
