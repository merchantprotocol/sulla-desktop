// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { ComposeSecretGuard, ComposeSecretGuardError } from '@pkg/backend/ComposeSecretGuard';
import { SECRET_BEARING_SERVICES, ServiceSecretComposeValues } from '@pkg/backend/ServiceSecretComposeValues';
import { sullaFilesCapabilityKey } from '@pkg/utils/sullaFilesKey';

import { ServiceSecretRepository } from '../../../app/Repositories/ServiceSecretRepository';
import { ServiceSecretProvider } from '../../../app/Services/ServiceSecret/ServiceSecretProvider';
import type { ServiceSecretGenerator } from '../../../app/Services/ServiceSecret/ServiceSecretGenerator';
import {
  corruptFileError, FakeClock, FakeInstallState, FakeSettingsStores, RecordingLogger, SequenceGenerator,
} from './ServiceSecretTestDoubles';

const DEV_PASSWORD = 'sulla_dev_password';
const REAL = 'Real_Install_Secret';
const COMPOSE_ASSET = new URL('../../../../assets/sulla-docker-compose.yaml', import.meta.url);

/** The env var names, per service, that carry the secret (a container lacking one falls back to its image default). */
const DATABASE_URL_VARS: Record<string, string[]> = {
  sulla_vault:      ['SULLA_VAULT_ADMIN_DATABASE_URL', 'SULLA_VAULT_DATABASE_URL', 'SULLA_VAULT_LEGACY_DATABASE_URL'],
  workflow_manager: ['SULLA_DATABASE_URL'],
  tools:            ['SULLA_DATABASE_URL'],
  sulla_files:      ['SULLA_FILES_DATABASE_URL'],
};

/**
 * Compose generation as sullaRuntimeBackend.prepareSullaComposeFile does it:
 * the shipped asset plus the four secret-bearing services with only their
 * non-secret env, then the one secret choke point, then the guard.
 */
function generateCompose(secret: ServiceSecretComposeValues): { compose: any; composeYaml: string } {
  const compose = yaml.parse(readFileSync(COMPOSE_ASSET, 'utf8'));

  compose.services.sulla_vault = { container_name: 'sulla_vault', environment: { SULLA_VAULT_MODE: 'desktop' } };
  compose.services.workflow_manager = { container_name: 'sulla_workflow_manager', environment: { SULLA_WORKFLOW_ROLE: 'manager' } };
  compose.services.tools = { container_name: 'sulla_tools', environment: { SULLA_DATABASE_POOL_MAX: '5' } };
  compose.services.sulla_files = { container_name: 'sulla_files', environment: { SULLA_FILES_MODE: 'desktop' } };
  secret.applyTo(compose);
  const composeYaml = yaml.stringify(compose, { defaultStringType: 'QUOTE_DOUBLE' });

  new ComposeSecretGuard(secret).assert(compose, composeYaml);

  return { compose, composeYaml };
}

function buildProvider(stores: FakeSettingsStores) {
  const provider = new ServiceSecretProvider(new ServiceSecretRepository(stores),
    new SequenceGenerator() as unknown as ServiceSecretGenerator, new FakeClock(), new RecordingLogger(),
    { maxWaitMs: 10_000, baseDelayMs: 100, maxDelayMs: 1_000 });

  provider.useInstallState(new FakeInstallState(stores));

  return provider;
}

describe('compose generation with the service secret', () => {
  // risk: sign-in / security — the 2026-11-16 07:26 regression: a regeneration after boot wrote the dev password
  it('a mid-session regeneration with the settings store unreadable never emits the dev password', async() => {
    const stores = new FakeSettingsStores();
    const provider = buildProvider(stores);

    stores.file = { sullaServicePassword: REAL };
    generateCompose(await ServiceSecretComposeValues.resolve(provider)); // boot

    // Mid-session: the bootstrap file is mid-write/corrupt and PostgreSQL is restarting.
    stores.filePermanentFailure = corruptFileError();
    stores.file = {};
    stores.databaseFailures = Array.from({ length: 10 }, () => new Error('ECONNREFUSED'));
    const { compose, composeYaml } = generateCompose(await ServiceSecretComposeValues.resolve(provider));

    expect(composeYaml).not.toContain(DEV_PASSWORD);
    for (const [service, names] of Object.entries(DATABASE_URL_VARS)) {
      for (const name of names) {
        expect(compose.services[service].environment[name], `${ service } ${ name }`).toMatch(/^postgresql:\/\/sulla:Real_Install_Secret@postgres:5432\//);
      }
    }
    expect(compose.services.tools.environment.SULLA_FILES_CAPABILITY_SECRET).toBe(REAL);
    expect(compose.services.sulla_files.environment.SULLA_FILES_LOCAL_TOKEN).toBe(REAL);
    expect(compose.services.postgres.environment).toContain(`POSTGRES_PASSWORD=${ REAL }`);
  });

  // risk: security — no fallback credential anywhere in the generated document
  it('the whole generated compose YAML contains no dev password for every service', async() => {
    const stores = new FakeSettingsStores();

    stores.file = { sullaServicePassword: REAL };
    const { compose, composeYaml } = generateCompose(await ServiceSecretComposeValues.resolve(buildProvider(stores)));

    expect(composeYaml).not.toContain(DEV_PASSWORD);
    for (const service of Object.keys(compose.services)) {
      expect(yaml.stringify(compose.services[service]), service).not.toContain(DEV_PASSWORD);
    }
  });

  // risk: sign-in — every regeneration sets every secret var; a service can never fall back to its image default
  it('the guard refuses a compose document where a secret-bearing service lost a DATABASE_URL', () => {
    const secret = new ServiceSecretComposeValues(REAL);

    for (const service of SECRET_BEARING_SERVICES) {
      const compose: any = { services: { postgres: { environment: [`POSTGRES_PASSWORD=${ REAL }`] } } };

      compose.services[service] = { environment: {} };
      secret.applyTo(compose);
      delete compose.services[service].environment[DATABASE_URL_VARS[service][0]];

      expect(() => new ComposeSecretGuard(secret).assert(compose, yaml.stringify(compose)), service).toThrow(ComposeSecretGuardError);
    }
  });

  // risk: security — a fallback credential anywhere in the YAML stops the write
  it('the guard refuses a document carrying the dev password as a fallback', () => {
    const secret = new ServiceSecretComposeValues(REAL);
    const compose: any = { services: { tools: { environment: {} } } };

    secret.applyTo(compose);
    compose.services.tools.environment.SULLA_DATABASE_URL = `postgresql://sulla:${ DEV_PASSWORD }@postgres:5432/sulla`;

    expect(() => new ComposeSecretGuard(secret).assert(compose, yaml.stringify(compose))).toThrow(/tools SULLA_DATABASE_URL/);
  });

  // risk: security / permissions — under trust any agent container on sulla_default logs in as superuser without a password
  it('the shipped postgres service does not ask for trust auth', () => {
    const compose = yaml.parse(readFileSync(COMPOSE_ASSET, 'utf8'));
    const environment: string[] = compose.services.postgres.environment;

    expect(environment.filter(entry => entry.startsWith('POSTGRES_HOST_AUTH_METHOD='))).toEqual([]);
  });

  // risk: security / permissions — a regenerated compose file can never reintroduce passwordless network logins
  it('the guard refuses POSTGRES_HOST_AUTH_METHOD=trust in list or map form', () => {
    const secret = new ServiceSecretComposeValues(REAL);
    const asList: any = { services: { postgres: { environment: ['POSTGRES_HOST_AUTH_METHOD=trust', `POSTGRES_PASSWORD=${ REAL }`] } } };
    const asMap: any = { services: { postgres: { environment: { POSTGRES_HOST_AUTH_METHOD: 'TRUST', POSTGRES_PASSWORD: REAL } } } };

    for (const compose of [asList, asMap]) {
      expect(() => new ComposeSecretGuard(secret).assert(compose, yaml.stringify(compose))).toThrow(/postgres POSTGRES_HOST_AUTH_METHOD allows passwordless/);
    }
  });

  // risk: sign-in — scram (the image default) and an absent setting stay accepted, so boot is not blocked
  it('the guard accepts scram-sha-256 and a missing auth method', () => {
    const secret = new ServiceSecretComposeValues(REAL);
    const scram: any = { services: { postgres: { environment: ['POSTGRES_HOST_AUTH_METHOD=scram-sha-256', `POSTGRES_PASSWORD=${ REAL }`] } } };

    expect(() => new ComposeSecretGuard(secret).assert(scram, yaml.stringify(scram))).not.toThrow();
    expect(() => generateCompose(secret)).not.toThrow();
  });

  // risk: data accuracy (B4) — an install whose stored secret IS the dev password keeps working
  it('allows the dev password only when it is the install\'s stored secret', () => {
    const secret = new ServiceSecretComposeValues(DEV_PASSWORD);
    const { composeYaml } = generateCompose(secret);

    expect(composeYaml).toContain(`POSTGRES_PASSWORD=${ DEV_PASSWORD }`);
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
