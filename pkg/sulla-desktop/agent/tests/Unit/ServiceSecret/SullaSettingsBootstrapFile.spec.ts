// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsBootstrapFileCorruptError, SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { ServiceSecretRepository } from '../../../app/Repositories/ServiceSecretRepository';
import { ServiceSecretGenerator } from '../../../app/Services/ServiceSecret/ServiceSecretGenerator';
import { ServiceSecretProvider } from '../../../app/Services/ServiceSecret/ServiceSecretProvider';
import { FakeClock, RecordingLogger } from './ServiceSecretTestDoubles';

/**
 * The real SullaSettingsModel before PostgreSQL is up (isReady=false): every
 * read and write goes to the bootstrap file on disk.
 */
describe('SullaSettingsModel bootstrap file (pre-database store)', () => {
  let directory: string;
  let file: string;

  beforeEach(async() => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-settings-'));
    file = path.join(directory, 'sulla-settings-fallback.json');
    SullaSettingsModel.setFallbackFilePath(file);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async() => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  function provider(): ServiceSecretProvider {
    return new ServiceSecretProvider(new ServiceSecretRepository(SullaSettingsModel), new ServiceSecretGenerator(),
      new FakeClock(), new RecordingLogger(), { maxWaitMs: 1_000, baseDelayMs: 100, maxDelayMs: 500 });
  }

  // risk: data accuracy — concurrent boot writes used to drop each other's keys
  it('keeps every key when many settings are written concurrently', async() => {
    await fs.writeFile(file, JSON.stringify({ sullaServicePassword: 'kept-secret' }));

    await Promise.all(Array.from({ length: 20 }, (_, index) => SullaSettingsModel.set(`key${ index }`, index)));

    const data = JSON.parse(await fs.readFile(file, 'utf8'));

    expect(data.sullaServicePassword).toBe('kept-secret');
    for (let index = 0; index < 20; index++) expect(data[`key${ index }`]).toBe(index);
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  // risk: data accuracy — "unreadable" must be distinguishable from "absent"
  it('reports a missing file as null and a corrupt file as an error, never as an empty object', async() => {
    expect(await SullaSettingsModel.readBootstrapFile()).toBeNull();

    await fs.writeFile(file, '{"sullaServicePassword": "tru');
    await expect(SullaSettingsModel.readBootstrapFile()).rejects.toBeInstanceOf(SettingsBootstrapFileCorruptError);
  });

  // risk: data accuracy — a corrupt file is kept for recovery, not silently overwritten
  it('moves a corrupt file aside before writing a fresh one', async() => {
    await fs.writeFile(file, 'not json');

    await SullaSettingsModel.set('sullaInstalled', true);

    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ sullaInstalled: true });
    const aside = (await fs.readdir(directory)).filter(name => name.includes('.corrupt-'));

    expect(aside).toHaveLength(1);
    expect(await fs.readFile(path.join(directory, aside[0]), 'utf8')).toBe('not json');
  });

  // risk: sign-in — the stored install secret is returned unchanged
  it('returns the install secret already in the bootstrap file', async() => {
    await fs.writeFile(file, JSON.stringify({ sullaServicePassword: 'Existing_Install_Secret' }));

    expect(await provider().get()).toBe('Existing_Install_Secret');
  });

  // risk: security — the old code path returned and persisted the public dev password here
  it('on a file without the secret, generates and persists a strong one, never the dev password', async() => {
    await fs.writeFile(file, JSON.stringify({ sullaInstalled: false }));

    const secret = await provider().get();
    const data = JSON.parse(await fs.readFile(file, 'utf8'));

    expect(secret).not.toBe('sulla_dev_password');
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(data.sullaServicePassword).toBe(secret);
    expect(data.sullaInstalled).toBe(false);
  });
});
