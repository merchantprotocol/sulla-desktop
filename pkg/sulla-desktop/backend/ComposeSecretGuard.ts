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
 * the same password, and no known fallback credential appears anywhere in the
 * YAML unless it genuinely is this install's stored secret.
 */
export class ComposeSecretGuard {
  /** Credentials that only ever appear as a fallback (baked into images and old builds). */
  static readonly FALLBACK_CREDENTIALS: readonly string[] = ['sulla_dev_password'];

  constructor(private readonly secret: ServiceSecretComposeValues) {}

  assert(compose: ComposeDocument, composeYaml: string): void {
    const problems = [...this.environmentProblems(compose), ...this.fallbackProblems(composeYaml)];

    if (problems.length > 0) throw new ComposeSecretGuardError(problems);
  }

  private environmentProblems(compose: ComposeDocument): string[] {
    const problems: string[] = [];

    for (const service of SECRET_BEARING_SERVICES) {
      const definition = compose.services?.[service];

      if (!definition) continue;
      const environment = Array.isArray(definition.environment) ? {} : definition.environment ?? {};

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

  private fallbackProblems(composeYaml: string): string[] {
    return ComposeSecretGuard.FALLBACK_CREDENTIALS
      .filter(credential => credential !== this.secret.raw && composeYaml.includes(credential))
      .map(() => 'a fallback development credential appears in the compose file');
  }
}
