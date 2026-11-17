// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { PostgresVaultProfileActivationRepository } from '../src/repositories/PostgresVaultProfileActivationRepository.js';

describe('profile activation rollback', () => {
  it('fails closed when no active mapping row exists', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const repository = new PostgresVaultProfileActivationRepository({ query } as never);
    await expect(repository.setActiveDatabase('legacy_vault')).rejects.toThrow(/no active/i);
    expect(query).toHaveBeenCalledOnce();
  });

  it('updates the existing pointer using a bound database identifier', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const repository = new PostgresVaultProfileActivationRepository({ query } as never);
    await repository.setActiveDatabase('legacy_vault');
    expect(query).toHaveBeenCalledWith(expect.any(String), ['legacy_vault']);
  });
});
