// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { sullaFilesCapabilityKey } from '@pkg/utils/sullaFilesKey';

/** The compose services whose environment carries the service secret. */
export type SecretBearingService = 'sulla_vault' | 'workflow_manager' | 'tools' | 'sulla_files';

export const SECRET_BEARING_SERVICES: readonly SecretBearingService[] = ['sulla_vault', 'workflow_manager', 'tools', 'sulla_files'];

interface ComposeServiceDefinition {
  environment?: Record<string, unknown> | string[];
}

/** Anything that resolves the install's service secret (ServiceSecretProvider). */
export interface ServiceSecretSource {
  get(): Promise<string>;
}

/**
 * Every place the install service secret enters the generated compose file.
 *
 * - Plain env values are `$`-escaped so Compose never interpolates them.
 * - Inside `postgresql://` URLs the secret is percent-encoded first, so older
 *   generated passwords holding `#`, `%` or `@` still parse (drivers decode it).
 * - The Files capability signing key is derived from the raw secret, the same
 *   input Desktop signs with, never from the `$`-escaped compose text.
 */
export class ServiceSecretComposeValues {
  constructor(private readonly secret: string) {
    if (!secret) throw new Error('Service secret is empty');
  }

  static async resolve(source: ServiceSecretSource): Promise<ServiceSecretComposeValues> {
    return new ServiceSecretComposeValues(await source.get());
  }

  private static escape(value: string): string {
    return value.replace(/\$/g, '$$$$');
  }

  /** The unescaped secret, for host-side files only (never compose text). */
  get raw(): string {
    return this.secret;
  }

  /** The secret as a compose env value. */
  get envValue(): string {
    return ServiceSecretComposeValues.escape(this.secret);
  }

  /** A compose-ready connection URL for the `sulla` role on the guest PostgreSQL. */
  databaseUrl(database: string): string {
    return ServiceSecretComposeValues.escape(`postgresql://sulla:${ encodeURIComponent(this.secret) }@postgres:5432/${ database }`);
  }

  /** The Files capability signing key (hex), derived exactly as Desktop derives it. */
  get filesCapabilitySigningKey(): string {
    return sullaFilesCapabilityKey(this.secret);
  }

  /** Every secret-bearing env var of one service, compose-ready. */
  environmentFor(service: SecretBearingService): Record<string, string> {
    switch (service) {
    case 'sulla_vault':
      return {
        SULLA_VAULT_ADMIN_DATABASE_URL:  this.databaseUrl('sulla'),
        SULLA_VAULT_DATABASE_URL:        this.databaseUrl('sulla_vault'),
        SULLA_VAULT_LEGACY_DATABASE_URL: this.databaseUrl('sulla'),
      };
    case 'workflow_manager':
      return { SULLA_DATABASE_URL: this.databaseUrl('sulla') };
    case 'tools':
      return { SULLA_DATABASE_URL: this.databaseUrl('sulla'), SULLA_FILES_CAPABILITY_SECRET: this.envValue };
    case 'sulla_files':
      return {
        SULLA_FILES_DATABASE_URL:           this.databaseUrl('sulla'),
        SULLA_FILES_CAPABILITY_SIGNING_KEY: this.filesCapabilitySigningKey,
        SULLA_FILES_LOCAL_TOKEN:            this.envValue,
      };
    }
  }

  /**
   * The one place the secret enters a generated compose document: set the
   * secret env of every secret-bearing service present, and the PostgreSQL
   * password. Every (re)generation goes through here, so no service can be
   * left to fall back to a default credential baked into its image.
   */
  applyTo(compose: { services?: Record<string, ComposeServiceDefinition | undefined> }): void {
    for (const service of SECRET_BEARING_SERVICES) {
      const definition = compose.services?.[service];

      if (!definition) continue;
      if (Array.isArray(definition.environment)) throw new Error(`compose service ${ service } must use a map environment`);
      definition.environment = { ...(definition.environment ?? {}), ...this.environmentFor(service) };
    }
    const postgres = compose.services?.postgres;

    if (postgres && Array.isArray(postgres.environment)) postgres.environment = this.applyToPostgresEnvironment(postgres.environment);
  }

  /** Replace POSTGRES_PASSWORD in a compose `environment:` list (the asset ships a placeholder). */
  applyToPostgresEnvironment(environment: readonly string[]): string[] {
    return environment.map(entry => (entry.startsWith('POSTGRES_PASSWORD=') ? `POSTGRES_PASSWORD=${ this.envValue }` : entry));
  }
}
