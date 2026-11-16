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
  corruptFileError, FakeClock, FakeInstallState, FakeSettingsStores, RecordingLogger, SequenceGenerator,
} from './ServiceSecretTestDoubles';

const PROPERTY = 'sullaServicePassword';
const REAL = 'Real-Install-Secret_0123456789abcdef';
const DEV_PASSWORD = 'sulla_dev_password';

function build(stores = new FakeSettingsStores(), generator = new SequenceGenerator()) {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const repository = new ServiceSecretRepository(stores, logger);
  const install = new FakeInstallState(stores);
  const provider = new ServiceSecretProvider(repository, generator as unknown as ServiceSecretGenerator, clock, logger,
    { maxWaitMs: 10_000, baseDelayMs: 100, maxDelayMs: 1_000 });

  provider.useInstallState(install);

  return { stores, generator, clock, logger, provider, install };
}

describe('ServiceSecretProvider', () => {
  // risk: data accuracy / sign-in — the 2026-11-16 boot wrote the dev password into compose
  it('waits while the settings store is unreadable at boot, then returns the real value', async() => {
    const { stores, generator, clock, provider } = build();

    stores.file = { [PROPERTY]: REAL };
    stores.fileFailures = [corruptFileError(), new Error('EBUSY: resource busy')];

    const secret = await provider.get();

    expect(secret).toBe(REAL);
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
  it('on a fresh install generates once, persists it, and concurrent callers share it', async() => {
    const { stores, generator, provider, install } = build();

    install.fresh = true;
    stores.file = null;

    const results = await Promise.all([provider.get(), provider.get(), provider.get(), provider.get()]);

    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('generated-secret-1');
    expect(generator.calls).toBe(1);
    expect(stores.file).toEqual({ [PROPERTY]: 'generated-secret-1' });
    expect(install.databaseReads).toBe(0);
  });

  // risk: sign-in / data accuracy (B1) — file without the key on an installed system: the database decides
  it('on an installed system whose file lacks the secret, reads the database and adopts its value', async() => {
    const { stores, generator, provider, install } = build();

    stores.file = {};
    stores.database.set(PROPERTY, REAL);

    expect(await provider.get()).toBe(REAL);
    expect(generator.calls).toBe(0);
    expect(install.databaseReads).toBe(1);
    expect(stores.file?.[PROPERTY]).toBe(REAL);
  });

  // risk: irreversible side effect (B1) — never invent a secret on an install that already has data
  it('on an installed system with no stored secret anywhere, throws with recovery guidance', async() => {
    const { stores, generator, provider } = build();

    stores.file = {};

    await expect(provider.get()).rejects.toThrow(/Restore "sullaServicePassword"/);
    expect(generator.calls).toBe(0);
  });

  // risk: irreversible side effect (B1) — a database that cannot be read is not "absent"
  it('throws when the database cannot be read, and generates nothing', async() => {
    const { stores, generator, provider, install } = build();

    stores.file = {};
    install.readFailure = new Error('No such container: sulla_postgres');

    await expect(provider.get()).rejects.toBeInstanceOf(ServiceSecretUnavailableError);
    expect(generator.calls).toBe(0);
  });

  // risk: security (B4) — no rotation this release; the stored dev password is consulted against PostgreSQL
  it('when the file holds the dev password and PostgreSQL holds another value, uses the PostgreSQL value', async() => {
    const { stores, generator, provider } = build();

    stores.file = { [PROPERTY]: DEV_PASSWORD };
    stores.database.set(PROPERTY, REAL);

    expect(await provider.get()).toBe(REAL);
    expect(stores.file?.[PROPERTY]).toBe(REAL);
    expect(generator.calls).toBe(0);
  });

  // risk: data accuracy (B4) — Files keys, backup HMACs and recipes derive from the stored secret
  it('keeps the dev password when PostgreSQL holds it too (it is this install\'s real secret)', async() => {
    const { stores, generator, provider, logger } = build();

    stores.file = { [PROPERTY]: DEV_PASSWORD };
    stores.database.set(PROPERTY, DEV_PASSWORD);

    expect(await provider.get()).toBe(DEV_PASSWORD);
    expect(generator.calls).toBe(0);
    expect(logger.lines.some(line => line.includes('historical development password'))).toBe(true);
    expect(logger.lines.join('\n')).not.toContain(DEV_PASSWORD);
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

  // risk: data accuracy (B2) — the database is authoritative: a differing value wins and is announced
  it('when the database becomes ready with a different value, adopts it, mirrors it and announces the change', async() => {
    const { stores, provider } = build();
    const changes: string[] = [];

    provider.onChange(reason => {
      changes.push(reason);
    });
    stores.file = { [PROPERTY]: 'value-compose-used' };
    stores.database.set(PROPERTY, REAL);

    expect(await provider.get()).toBe('value-compose-used');
    stores.ready = true;
    expect(await provider.get()).toBe(REAL);
    await Promise.resolve();
    await Promise.resolve();

    expect(stores.database.get(PROPERTY)).toBe(REAL);
    expect(stores.file?.[PROPERTY]).toBe(REAL);
    expect(changes).toHaveLength(1);
    expect(stores.writes.filter(write => write.store === 'database')).toEqual([]);
  });

  // risk: data accuracy (B2) — the database is written only when it confirms it has no value
  it('writes the bootstrap value to the database only when the database has none', async() => {
    const { stores, provider } = build();
    const changes: string[] = [];

    provider.onChange(reason => {
      changes.push(reason);
    });
    stores.file = { [PROPERTY]: REAL };

    expect(await provider.get()).toBe(REAL);
    stores.ready = true;
    await provider.converge();

    expect(stores.database.get(PROPERTY)).toBe(REAL);
    expect(changes).toEqual([]);
  });

  // risk: availability / data accuracy (B3) — a corrupt file keeps its readable secret
  it('repairs a file that stays corrupt and keeps the secret still readable from it', async() => {
    const { stores, generator, provider } = build();

    stores.filePermanentFailure = corruptFileError();
    stores.salvageable = { [PROPERTY]: REAL, sullaInstalled: true };

    expect(await provider.get()).toBe(REAL);
    expect(stores.quarantined).toBe(1);
    expect(stores.file).toEqual({ [PROPERTY]: REAL, sullaInstalled: true });
    expect(generator.calls).toBe(0);
  });

  // risk: irreversible side effect (B3) — corrupt + DB has the value: use it, never generate
  it('repairs a corrupt file without the secret by adopting the database value', async() => {
    const { stores, generator, provider } = build();

    stores.filePermanentFailure = corruptFileError();
    stores.database.set(PROPERTY, REAL);

    expect(await provider.get()).toBe(REAL);
    expect(generator.calls).toBe(0);
  });

  // risk: irreversible side effect (B3) — corrupt + nothing in the database on an installed system: fail, never generate
  it('throws on a corrupt file with no recoverable secret and none in the database', async() => {
    const { stores, generator, provider } = build();

    stores.filePermanentFailure = corruptFileError();

    await expect(provider.get()).rejects.toBeInstanceOf(ServiceSecretUnavailableError);
    expect(stores.quarantined).toBe(1);
    expect(generator.calls).toBe(0);
  });

  // risk: availability — Desktop's PostgreSQL client gets the secret to connect without waiting on a sync that needs that connection
  it('value() returns the secret without touching the database, even when the database is ready', async() => {
    const { stores, provider } = build();

    stores.file = { [PROPERTY]: REAL };
    // First resolution while settings are still file-backed, as at boot.
    expect(await provider.value()).toBe(REAL);

    stores.ready = true;
    stores.databaseFailures = [new Error('would need the connection being opened')];
    expect(await provider.value()).toBe(REAL);
    expect(stores.databaseFailures).toHaveLength(1);
    expect(stores.database.has(PROPERTY)).toBe(false);
  });

  // risk: data accuracy — mid-session reads never touch a store that may be mid-write or offline
  it('after resolving once, returns the same value while every store is unreadable', async() => {
    const { stores, provider } = build();

    stores.file = { [PROPERTY]: REAL };
    expect(await provider.get()).toBe(REAL);

    stores.filePermanentFailure = corruptFileError();
    stores.databaseFailures = Array.from({ length: 5 }, () => new Error('ECONNREFUSED'));

    expect(await provider.get()).toBe(REAL);
    expect(stores.quarantined).toBe(0);
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
