// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { ServiceSecretComposeValues } from '@pkg/backend/ServiceSecretComposeValues';
import { sullaFilesCapabilityKey } from '@pkg/utils/sullaFilesKey';

import { ServiceSecretRepository } from '../../../app/Repositories/ServiceSecretRepository';
import { ServiceSecretProvider } from '../../../app/Services/ServiceSecret/ServiceSecretProvider';
import type { ServiceSecretGenerator } from '../../../app/Services/ServiceSecret/ServiceSecretGenerator';
import { corruptFileError, FakeClock, FakeSettingsStores, RecordingLogger, SequenceGenerator } from './ServiceSecretTestDoubles';

const DEV_PASSWORD = 'sulla_dev_password';
const COMPOSE_ASSET = new URL('../../../../assets/sulla-docker-compose.yaml', import.meta.url);

/** The secret-bearing part of compose generation, as sullaRuntimeBackend.prepareSullaComposeFile builds it. */
function generateCompose(secret: ServiceSecretComposeValues): string {
  const compose = yaml.parse(readFileSync(COMPOSE_ASSET, 'utf8'));

  compose.services.postgres.environment = secret.applyToPostgresEnvironment(compose.services.postgres.environment);
  compose.services.sulla_vault = { environment: {
    SULLA_VAULT_ADMIN_DATABASE_URL: secret.databaseUrl('sulla'),
    SULLA_VAULT_DATABASE_URL:       secret.databaseUrl('sulla_vault'),
  } };
  compose.services.tools = { environment: {
    SULLA_DATABASE_URL: secret.databaseUrl('sulla'), SULLA_FILES_CAPABILITY_SECRET: secret.envValue,
  } };
  compose.services.sulla_files = { environment: {
    SULLA_FILES_DATABASE_URL:           secret.databaseUrl('sulla'),
    SULLA_FILES_CAPABILITY_SIGNING_KEY: secret.filesCapabilitySigningKey,
    SULLA_FILES_LOCAL_TOKEN:            secret.envValue,
  } };

  return yaml.stringify(compose, { defaultStringType: 'QUOTE_DOUBLE' });
}

describe('compose generation with the service secret', () => {
  // risk: sign-in / security — the 2026-11-16 regression: settings unreadable at boot put the dev password in compose
  it('never contains the dev password when settings were unreadable at boot', async() => {
    const stores = new FakeSettingsStores();

    stores.file = { sullaServicePassword: 'Real_Install_Secret' };
    stores.fileFailures = [corruptFileError(), new Error('EBUSY')];
    const provider = new ServiceSecretProvider(new ServiceSecretRepository(stores),
      new SequenceGenerator() as unknown as ServiceSecretGenerator, new FakeClock(), new RecordingLogger());

    const composeYaml = generateCompose(await ServiceSecretComposeValues.resolve(provider));

    expect(composeYaml).not.toContain(DEV_PASSWORD);
    expect(composeYaml).toContain('POSTGRES_PASSWORD=Real_Install_Secret');
    expect(composeYaml).toContain('postgresql://sulla:Real_Install_Secret@postgres:5432/sulla');
  });

  // risk: sign-in — a stored dev password is retired, not shipped into containers
  it('never contains the dev password when a store still holds it', async() => {
    const stores = new FakeSettingsStores();

    stores.file = { sullaServicePassword: DEV_PASSWORD };
    const provider = new ServiceSecretProvider(new ServiceSecretRepository(stores),
      new SequenceGenerator() as unknown as ServiceSecretGenerator, new FakeClock(), new RecordingLogger());

    expect(generateCompose(await ServiceSecretComposeValues.resolve(provider))).not.toContain(DEV_PASSWORD);
  });

  // risk: data accuracy — legacy passwords with URL/compose metacharacters must reach services intact
  it('encodes a legacy password so every DATABASE_URL decodes back to the exact secret', () => {
    const legacy = 'a#b%c@d$e!f*(g)+';
    const secret = new ServiceSecretComposeValues(legacy);
    // Compose turns `$$` back into `$` when it reads the file.
    const url = new URL(secret.databaseUrl('sulla_vault').replace(/\$\$/g, '$'));

    expect(decodeURIComponent(url.password)).toBe(legacy);
    expect(url.hostname).toBe('postgres');
    expect(url.pathname).toBe('/sulla_vault');
    expect(secret.envValue.replace(/\$\$/g, '$')).toBe(legacy);
  });

  // risk: sign-in — Files verifies capability tokens Desktop signs with the raw secret
  it('derives the Files signing key from the raw secret, as Desktop does', () => {
    const legacy = 'pa$$word';

    expect(new ServiceSecretComposeValues(legacy).filesCapabilitySigningKey).toBe(sullaFilesCapabilityKey(legacy));
  });
});
