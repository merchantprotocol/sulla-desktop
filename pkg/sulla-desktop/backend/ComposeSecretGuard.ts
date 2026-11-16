// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SECRET_BEARING_SERVICES, type ServiceSecretComposeValues } from './ServiceSecretComposeValues';

/** Thrown before a compose file with a missing, wrong or fallback credential is written. Never holds values. */
export class ComposeSecretGuardError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Refusing to write the Sulla compose file: ${ problems.join('; ') }`);
    this.name = 'ComposeSecretGuardError';
  }
}

interface ComposeDocument {
  services?: Record<string, { environment?: Record<string, unknown> | string[] } | undefined>;
}

/**
 * Last check on every generated compose document, run just before it is
 * written: each secret-bearing service carries every secret env var with the
 * install's value (so none can fall back to an image default), PostgreSQL gets
 * the same password, no service asks PostgreSQL for passwordless (`trust`)
 * network auth, and no known fallback credential appears anywhere in the
 * YAML unless it genuinely is this install's stored secret.
 */
export class ComposeSecretGuard {
  /** Credentials that only ever appear as a fallback (baked into images and old builds). */
  static readonly FALLBACK_CREDENTIALS: readonly string[] = ['sulla_dev_password'];

  /** PostgreSQL auth methods that let a network client in without the service secret. */
  static readonly PASSWORDLESS_AUTH_METHODS: readonly string[] = ['trust'];

  constructor(private readonly secret: ServiceSecretComposeValues) {}

  assert(compose: ComposeDocument, composeYaml: string): void {
    const problems = [...this.environmentProblems(compose), ...this.authMethodProblems(compose), ...this.fallbackProblems(composeYaml)];

    if (problems.length > 0) throw new ComposeSecretGuardError(problems);
  }

  private environmentProblems(compose: ComposeDocument): string[] {
    const problems: string[] = [];

    for (const service of SECRET_BEARING_SERVICES) {
      const definition = compose.services?.[service];

      if (!definition) continue;
      const environment: Record<string, unknown> = Array.isArray(definition.environment) ? {} : definition.environment ?? {};

      for (const [name, expected] of Object.entries(this.secret.environmentFor(service))) {
        if (environment[name] === undefined || environment[name] === '') problems.push(`${ service } is missing ${ name }`);
        else if (environment[name] !== expected) problems.push(`${ service } ${ name } does not carry the install service secret`);
      }
    }
    const postgres = compose.services?.postgres?.environment;

    if (postgres) {
      const entries = Array.isArray(postgres) ? postgres : Object.entries(postgres).map(([key, value]) => `${ key }=${ value }`);

      if (!entries.includes(`POSTGRES_PASSWORD=${ this.secret.envValue }`)) problems.push('postgres POSTGRES_PASSWORD does not carry the install service secret');
    }

    return problems;
  }

  /** Any service asking the PostgreSQL entrypoint for passwordless network auth. */
  private authMethodProblems(compose: ComposeDocument): string[] {
    return Object.entries(compose.services ?? {})
      .filter(([, definition]) => ComposeSecretGuard.PASSWORDLESS_AUTH_METHODS.includes(this.hostAuthMethod(definition?.environment)))
      .map(([service]) => `${ service } POSTGRES_HOST_AUTH_METHOD allows passwordless network logins`);
  }

  private hostAuthMethod(environment: Record<string, unknown> | string[] | undefined): string {
    const entries = Array.isArray(environment) ? environment : Object.entries(environment ?? {}).map(([key, value]) => `${ key }=${ value }`);
    const entry = entries.find(item => typeof item === 'string' && item.trim().startsWith('POSTGRES_HOST_AUTH_METHOD='));

    return entry ? entry.slice(entry.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '').toLowerCase() : '';
  }

  private fallbackProblems(composeYaml: string): string[] {
    return ComposeSecretGuard.FALLBACK_CREDENTIALS
      .filter(credential => credential !== this.secret.raw && composeYaml.includes(credential))
      .map(() => 'a fallback development credential appears in the compose file');
  }
}
