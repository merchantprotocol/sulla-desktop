// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { sullaFilesCapabilityKey } from '@pkg/utils/sullaFilesKey';

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

  /** Replace POSTGRES_PASSWORD in a compose `environment:` list (the asset ships a placeholder). */
  applyToPostgresEnvironment(environment: readonly string[]): string[] {
    return environment.map(entry => (entry.startsWith('POSTGRES_PASSWORD=') ? `POSTGRES_PASSWORD=${ this.envValue }` : entry));
  }
}
