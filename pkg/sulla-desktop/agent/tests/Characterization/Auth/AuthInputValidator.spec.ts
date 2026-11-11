// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AccountPasswordRule, EmailCodeRule, EmailRule, ValidationRuleException, type Rule } from '@sulla/domain';

import { AuthInputValidator } from '../../../../composables/auth/AuthInputValidator';

describe('AuthInputValidator (renderer sign-in inputs over @sulla/domain rules)', () => {
  const validator = AuthInputValidator.withDomainRules();

  describe('email', () => {
    it('rejects a 300-character email (the 2026-10-31 bug) with the length copy', () => {
      // risk: permissions/data accuracy — an oversized address must never reach Cloud sign-in
      const tooLong = `${'a'.repeat(290)}@example.com`;
      expect(tooLong.length).toBeGreaterThan(254);

      expect(validator.email(tooLong)).toEqual({ ok: false, error: 'That email address is too long.' });
    });

    it('trims and lowercases a valid address and returns the normalized form', () => {
      // risk: sign-in — the stored and sent address must match the account, whatever case was typed
      expect(validator.email('  Jonathon@Example.COM ')).toEqual({ ok: true, value: 'jonathon@example.com' });
    });

    it('rejects empty input with the required copy', () => {
      // risk: sign-in — a blank address must not start a Cloud request
      expect(validator.email('   ')).toEqual({ ok: false, error: 'Email is required.' });
    });

    it.each([
      ['no-at-sign.example.com'],
      ['two@@example.com'],
      ['user@localhost'],
      ['user@example..com'],
      ['user@example.com.'],
      ['us er@example.com'],
    ])('rejects a malformed address %s with the valid-email copy', (raw) => {
      // risk: sign-in — malformed addresses fail before the server is asked
      expect(validator.email(raw)).toEqual({ ok: false, error: 'Please enter a valid email address.' });
    });
  });

  describe('email sign-in code', () => {
    it('accepts exactly six digits and returns them trimmed', () => {
      // risk: sign-in — the code is the only proof of email ownership on this path
      expect(validator.emailCode(' 482913 ')).toEqual({ ok: true, value: '482913' });
    });

    it.each([
      ['12345'],
      ['1234567'],
      ['12345a'],
      ['12 345 6'],
      ['1234-56'],
      [''],
    ])('rejects %j — only a 6-digit code is accepted', (raw) => {
      // risk: sign-in — a malformed code must not reach the verify call
      expect(validator.emailCode(raw)).toEqual({ ok: false, error: 'Enter the 6-digit code from the email.' });
    });
  });

  describe('account password', () => {
    it('rejects an empty password with the existing copy', () => {
      // risk: sign-in — empty password never reaches the account KDF
      expect(validator.password('')).toEqual({ ok: false, error: 'Enter a password.' });
    });

    it('keeps the password minimum unchanged: a one-character password is accepted as typed', () => {
      // risk: sign-in/key derivation — Desktop has no minimum; the password feeds the KDF byte-for-byte
      expect(validator.password('a')).toEqual({ ok: true, value: 'a' });
    });

    it('does not trim the password', () => {
      // risk: key derivation — trimming would change the KDF input and lock the user out
      expect(validator.password('  spaced  ')).toEqual({ ok: true, value: '  spaced  ' });
    });
  });

  describe('dependency injection', () => {
    it('uses the injected rules, not the domain defaults', () => {
      // risk: testability — the validator must take its rules through the constructor
      const alwaysPasses: Rule<string> = {
        check: (value: unknown) => String(value),
      } as unknown as Rule<string>;
      const injected = new AuthInputValidator({
        email: alwaysPasses,
        emailCode: new EmailCodeRule(),
        accountPassword: new AccountPasswordRule(),
      });

      expect(injected.email('not-an-email')).toEqual({ ok: true, value: 'not-an-email' });
    });

    it('rethrows errors that are not validation rejections', () => {
      // risk: sign-in — a programming error must surface, not be shown to the user as a validation message
      const broken = { check: () => { throw new Error('boom'); } } as unknown as Rule<string>;
      const injected = new AuthInputValidator({
        email: broken,
        emailCode: new EmailCodeRule(),
        accountPassword: new AccountPasswordRule(),
      });

      expect(() => injected.email('a@b.co')).toThrow('boom');
    });

    it('still maps a domain ValidationRuleException to its message', () => {
      // risk: copy — the user sees the rule's message, not a generic fallback
      const rejecting = { check: () => { throw new ValidationRuleException('x', 'custom copy'); } } as unknown as Rule<string>;
      const injected = new AuthInputValidator({
        email: rejecting,
        emailCode: new EmailCodeRule(),
        accountPassword: new AccountPasswordRule(),
      });

      expect(injected.email('a@b.co')).toEqual({ ok: false, error: 'custom copy' });
    });
  });

  it('builds on the real domain EmailRule (sanity)', () => {
    // risk: copy — the default wiring uses the shared rule classes
    expect(new EmailRule().codeFor('x'.repeat(300) + '@a.co')).toBe('email_too_long');
  });
});
