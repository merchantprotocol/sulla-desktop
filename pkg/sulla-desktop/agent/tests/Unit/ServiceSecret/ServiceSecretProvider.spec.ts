// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { ServiceSecretRepository } from '../../../app/Repositories/ServiceSecretRepository';
import { ServiceSecretGenerator } from '../../../app/Services/ServiceSecret/ServiceSecretGenerator';
import {
  ServiceSecretProvider, ServiceSecretUnavailableError,
} from '../../../app/Services/ServiceSecret/ServiceSecretProvider';
import {
  corruptFileError, FakeClock, FakeSettingsStores, RecordingLogger, SequenceGenerator,
} from './ServiceSecretTestDoubles';

const PROPERTY = 'sullaServicePassword';
const REAL = 'Real-Install-Secret_0123456789abcdef';
const DEV_PASSWORD = 'sulla_dev_password';

function build(stores = new FakeSettingsStores(), generator = new SequenceGenerator()) {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const repository = new ServiceSecretRepository(stores, logger);
  const provider = new ServiceSecretProvider(repository, generator as unknown as ServiceSecretGenerator, clock, logger,
    { maxWaitMs: 10_000, baseDelayMs: 100, maxDelayMs: 1_000 });

  return { stores, generator, clock, logger, provider };
}

describe('ServiceSecretProvider', () => {
  // risk: data accuracy / sign-in — the 2026-11-16 boot wrote the dev password into compose
  it('waits while the settings store is unreadable at boot, then returns the real value', async() => {
    const { stores, generator, clock, provider } = build();

    stores.file = { [PROPERTY]: REAL };
    stores.fileFailures = [corruptFileError(), new Error('EBUSY: resource busy')];

    const secret = await provider.get();

    expect(secret).toBe(REAL);
    expect(secret).not.toBe(DEV_PASSWORD);
    expect(clock.sleeps).toEqual([100, 200]);
    expect(generator.calls).toBe(0);
    expect(stores.writes).toEqual([]);
  });

  // risk: data accuracy — an unreadable store must never become a guessed credential
  it('fails loudly after the bounded wait instead of returning any credential', async() => {
    const { stores, generator, provider } = build();

    stores.filePermanentFailure = new Error('Fallback path not set');

    await expect(provider.get()).rejects.toBeInstanceOf(ServiceSecretUnavailableError);
    expect(generator.calls).toBe(0);
    expect(stores.writes).toEqual([]);
  });

  // risk: irreversible side effect — double generation would split containers and Desktop
  it('generates once on a confirmed-absent value, persists it, and concurrent callers share it', async() => {
    const { stores, generator, provider } = build();

    stores.file = { sullaInstalled: false };

    const results = await Promise.all([provider.get(), provider.get(), provider.get(), provider.get()]);

    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('generated-secret-1');
    expect(generator.calls).toBe(1);
    expect(stores.file?.[PROPERTY]).toBe('generated-secret-1');
    expect(await provider.get()).toBe('generated-secret-1');
  });

  // risk: data accuracy — a missing bootstrap file on a fresh install counts as absent
  it('treats a missing bootstrap file as absent and creates it with the new secret', async() => {
    const { stores, provider } = build();

    stores.file = null;

    expect(await provider.get()).toBe('generated-secret-1');
    expect(stores.file).toEqual({ [PROPERTY]: 'generated-secret-1' });
  });

  // risk: security — the public dev password must never be emitted even when a store holds it
  it('replaces a stored retired development password instead of returning it', async() => {
    const { stores, generator, provider } = build();

    stores.file = { [PROPERTY]: DEV_PASSWORD };

    const secret = await provider.get();

    expect(secret).not.toBe(DEV_PASSWORD);
    expect(generator.calls).toBe(1);
    expect(stores.file?.[PROPERTY]).toBe(secret);
  });

  // risk: data accuracy — once the database is up both stores must hold the same value
  it('with the database ready, saves a generated secret to the database and mirrors it to the file', async() => {
    const { stores, provider } = build();

    stores.ready = true;

    const secret = await provider.get();

    expect(stores.database.get(PROPERTY)).toBe(secret);
    expect(stores.file?.[PROPERTY]).toBe(secret);
  });

  // risk: data accuracy — a value only in PostgreSQL must reach the pre-database file for the next boot
  it('mirrors a database value into the bootstrap file without generating', async() => {
    const { stores, generator, provider } = build();

    stores.ready = true;
    stores.database.set(PROPERTY, REAL);
    stores.file = {};

    expect(await provider.get()).toBe(REAL);
    expect(stores.file?.[PROPERTY]).toBe(REAL);
    expect(generator.calls).toBe(0);
  });

  // risk: data accuracy — compose used the bootstrap value; later Desktop readers must agree with it
  it('converges the database to the value compose used once the database becomes ready', async() => {
    const { stores, provider } = build();

    stores.file = { [PROPERTY]: REAL };
    stores.database.set(PROPERTY, 'stale-database-value');

    expect(await provider.get()).toBe(REAL);
    stores.ready = true;
    expect(await provider.get()).toBe(REAL);
    expect(stores.database.get(PROPERTY)).toBe(REAL);
  });

  // risk: availability — a persistently corrupt file is moved aside instead of bricking every boot
  it('quarantines a bootstrap file that stays corrupt for the whole wait, then generates', async() => {
    const { stores, provider } = build();

    stores.filePermanentFailure = corruptFileError();

    const secret = await provider.get();

    expect(stores.quarantined).toBe(1);
    expect(secret).toBe('generated-secret-1');
    expect(stores.file?.[PROPERTY]).toBe(secret);
  });
});

describe('ServiceSecretGenerator', () => {
  // risk: security — the secret is embedded raw in env, headers and compose text
  it('produces 32 random bytes as URL-, env- and compose-safe base64url', () => {
    const secret = new ServiceSecretGenerator().generate();

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new ServiceSecretGenerator().generate()).not.toBe(secret);
  });
});
