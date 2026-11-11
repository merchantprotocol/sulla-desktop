// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  AccountPasswordRule,
  EmailCodeRule,
  EmailRule,
  ValidationRuleException,
  type Rule,
} from '@sulla/domain';

export type AuthInputResult = { ok: true; value: string } | { ok: false; error: string };

export interface AuthInputRules {
  readonly email: Rule<string>;
  readonly emailCode: Rule<string>;
  readonly accountPassword: Rule<string>;
}

/**
 * Renderer-facing validation for the account email, email sign-in code and account password.
 *
 * The rules come from `@sulla/domain`. A rejection carries the rule's own user-facing copy, which is the
 * same text FirstRunWelcome.vue has always shown. Desktop has no password minimum (only "not empty"), so
 * none is added here; Mobile's 8-character minimum is Mobile policy and stays in Mobile.
 *
 * Stateless. Build one per component or composable with `AuthInputValidator.withDomainRules()`.
 */
export class AuthInputValidator {
  constructor(private readonly rules: AuthInputRules) {}

  /** The domain rules wired into a validator. Each caller holds its own instance. */
  static withDomainRules(): AuthInputValidator {
    return new AuthInputValidator({
      email: new EmailRule(),
      emailCode: new EmailCodeRule(),
      accountPassword: new AccountPasswordRule(),
    });
  }

  /** Returns the normalized (trimmed, lowercased) address the app should store and send. */
  email(raw: string): AuthInputResult {
    return this.run(this.rules.email, raw);
  }

  /** Returns the trimmed code; only exactly six ASCII digits pass. */
  emailCode(raw: string): AuthInputResult {
    return this.run(this.rules.emailCode, raw);
  }

  /** Returns the password unchanged; it feeds the account KDF byte-for-byte. */
  password(raw: string): AuthInputResult {
    return this.run(this.rules.accountPassword, raw);
  }

  private run(rule: Rule<string>, raw: string): AuthInputResult {
    try {
      return { ok: true, value: rule.check(raw) };
    } catch (caught) {
      if (caught instanceof ValidationRuleException) return { ok: false, error: caught.message };
      throw caught;
    }
  }
}
