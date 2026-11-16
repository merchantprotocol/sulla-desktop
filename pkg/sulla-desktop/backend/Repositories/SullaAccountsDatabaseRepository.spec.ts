// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { SullaAccountsDatabaseRepository } from './SullaAccountsDatabaseRepository';

function guest(existsOutput: string | Error) {
  return {
    capture: vi.fn(async() => {
      if (existsOutput instanceof Error) throw existsOutput;

      return existsOutput;
    }),
    run: vi.fn(async() => undefined),
  };
}

describe('SullaAccountsDatabaseRepository', () => {
  it('queries pg_database through psql in the postgres container', async() => {
    const runner = guest('1\n');

    await expect(new SullaAccountsDatabaseRepository(runner).exists()).resolves.toBe(true);
    expect(runner.capture).toHaveBeenCalledWith([
      'docker', 'exec', 'sulla_postgres', 'psql', '-U', 'sulla', '-d', 'postgres', '-tAc',
      "SELECT 1 FROM pg_database WHERE datname='sulla_accounts'",
    ]);
  });

  // risk: data — an existing Accounts database must never be re-created.
  it('does not create the database when it already exists', async() => {
    const runner = guest(' 1 ');

    await new SullaAccountsDatabaseRepository(runner).ensureExists();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('creates the database with UTF8 from template0 when it is missing', async() => {
    const runner = guest('');

    await new SullaAccountsDatabaseRepository(runner).ensureExists();
    expect(runner.run).toHaveBeenCalledWith([
      'docker', 'exec', 'sulla_postgres', 'createdb', '-U', 'sulla', '--encoding=UTF8', '--template=template0', 'sulla_accounts',
    ]);
  });

  it('propagates a psql failure without trying to create the database', async() => {
    const runner = guest(new Error('psql: connection refused'));

    await expect(new SullaAccountsDatabaseRepository(runner).ensureExists()).rejects.toThrow('connection refused');
    expect(runner.run).not.toHaveBeenCalled();
  });
});
