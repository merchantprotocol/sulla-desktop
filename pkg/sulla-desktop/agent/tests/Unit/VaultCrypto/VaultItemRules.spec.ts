// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Characterization of @sulla/vault-crypto's custom-field and item-policy rules, pinned before the
// package moved into classes (oop-e5/vaultcrypto). Messages are part of the service contract.

import { describe, expect, it } from 'vitest';

import * as vc from '../../../../../../packages/vault-crypto/src/index';

const field = (overrides: Partial<vc.VaultItemCustomField> = {}): vc.VaultItemCustomField => ({
  id: 'f-1', label: 'PIN', type: 'text', value: '1234', ...overrides,
});

describe('vault-crypto custom fields', () => {
  it('returns the exact per-type value errors and accepts valid values', () => {
    // risk: data accuracy — invalid values must be refused before they are sealed into an item.
    const errors = ['url', 'email', 'date', 'phone', 'one-time', 'number', 'boolean']
      .map(type => vc.customFieldValueError(type, 'bad value'));
    expect(errors).toEqual([
      'must be a full URL such as https://example.com',
      'must be an email address',
      'must be a date (YYYY-MM-DD)',
      'must be a phone number',
      'must be a base32 secret or an otpauth:// URI',
      'must be a number',
      'must be Yes or No',
    ]);
    expect(vc.customFieldValueError('date', '2024-02-30')).toBe('must be a date (YYYY-MM-DD)');
    expect(vc.customFieldValueError('date', '2024-02-29')).toBeNull();
    expect(vc.customFieldValueError('one-time', 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP')).toBeNull();
    expect(vc.customFieldValueError('url', 'ftp://example.com')).toBe('must start with https://, http:// or mailto:');
    expect(vc.customFieldValueError('text', 'a\nb')).toBe('must be a single line');
    expect(vc.customFieldValueError('text', 'x'.repeat(8 * 1024 + 1))).toBe('must be 8 KiB or less');
    expect(vc.customFieldValueError('future-type', 'anything')).toBeNull();
    expect(vc.customFieldValueError('text', 5)).toBe('must be text');
  });

  it('validates a field list, trimming labels and keeping unknown types only when preserved', () => {
    // risk: data loss / integrity — newer-client fields must round-trip, invented types must not.
    expect(vc.validateCustomFields(undefined)).toEqual({ ok: true, fields: [] });
    expect(vc.validateCustomFields([field({ label: '  PIN ', hidden: true })]))
      .toEqual({ ok: true, fields: [{ id: 'f-1', label: 'PIN', type: 'text', value: '1234', hidden: true }] });
    expect(vc.validateCustomFields([field({ type: 'passkey-v2' })]))
      .toEqual({ ok: false, error: 'Custom field 1 has an unsupported type' });
    expect(vc.validateCustomFields([field({ type: 'passkey-v2' })], { preserved: [field({ type: 'passkey-v2' })] }).ok).toBe(true);
    expect(vc.validateCustomFields([field(), field({ id: 'f-2', label: 'pin' })]))
      .toEqual({ ok: false, error: 'Custom field 2 label is already used on this item' });
    expect(vc.validateCustomFields([field(), field({ label: 'Other' })]))
      .toEqual({ ok: false, error: 'Custom field 2 repeats another field\'s id' });
    expect(vc.validateCustomFields([{ ...field(), extra: 1 }]))
      .toEqual({ ok: false, error: 'Custom field 1 has unsupported properties' });
    expect(vc.validateCustomFields([field({ type: 'email', value: 'nope' })]))
      .toEqual({ ok: false, error: 'Custom field 1 must be an email address' });
    expect(vc.validateCustomFields(Array.from({ length: 41 }, (_, i) => field({ id: `f-${ i }`, label: `L${ i }` }))))
      .toEqual({ ok: false, error: 'Items can have at most 40 custom fields' });
    expect(vc.validateCustomFields('x')).toEqual({ ok: false, error: 'Custom fields must be a list' });
    expect(vc.isSecretCustomField({ type: 'one-time' })).toBe(true);
    expect(vc.isSecretCustomField({ type: 'text', hidden: true })).toBe(true);
    expect(vc.isSecretCustomField({ type: 'text' })).toBe(false);
    expect(vc.isKnownCustomFieldType('linked')).toBe(true);
    expect(vc.isKnownCustomFieldType('nope')).toBe(false);
  });
});

describe('vault-crypto item policy', () => {
  it('validates proxy declarations, refusing broker-owned headers and unknown custom sources', () => {
    // risk: secret disclosure — an agent must not steer a credential into a header the broker owns.
    const rule = { source: 'password' as const, target: 'header' as const, name: 'Authorization', scheme: 'Bearer' as const };
    expect(vc.validateVaultItemProxy({ proxy: { hosts: ['API.Example.com', 'api.example.com'], rules: [rule] } }))
      .toEqual({ ok: true, proxy: { hosts: ['api.example.com'], rules: [rule] } });
    expect(vc.validateVaultItemProxy({ proxy: { hosts: ['api.example.com'], rules: [{ ...rule, name: 'Cookie' }] } }))
      .toEqual({ ok: false, error: 'Header Cookie is owned by the broker' });
    expect(vc.validateVaultItemProxy({ proxy: { hosts: ['api.example.com'], rules: [{ ...rule, target: 'query', name: 'Cookie' }] } }).ok)
      .toBe(true);
    expect(vc.validateVaultItemProxy({ proxy: { hosts: ['api.example.com'], rules: [{ ...rule, source: 'custom:Token' }] } }))
      .toEqual({ ok: false, error: 'Custom source Token does not exist' });
    expect(vc.validateVaultItemProxy({
      customFields: [field({ label: 'Token' })],
      proxy:        { hosts: ['*.example.com'], rules: [{ ...rule, source: 'custom:Token' }] },
    }).ok).toBe(true);
    expect(vc.validateVaultItemProxy({ proxy: { hosts: ['bad host'], rules: [rule] } }))
      .toEqual({ ok: false, error: 'Agent usage contains an invalid host' });
    expect(vc.validateVaultItemProxy({})).toEqual({ ok: false, error: 'Agent usage requires 1–20 hosts and 1–5 rules' });
  });

  it('maps legacy llm_access values and enforces the agent allow-list', () => {
    // risk: authorization — legacy items must keep their exact agent access level.
    expect(vc.agentPolicyFromLegacyLlmAccess('none')).toEqual(vc.DEFAULT_AGENT_POLICY);
    expect(vc.agentPolicyFromLegacyLlmAccess(' FULL ')).toEqual({ ...vc.DEFAULT_AGENT_POLICY, mode: 'agents', level: 'full' });
    expect(vc.agentPolicyFromLegacyLlmAccess(null)).toEqual({ ...vc.DEFAULT_AGENT_POLICY, mode: 'agents', level: 'autofill' });
    const policy = { ...vc.DEFAULT_AGENT_POLICY, mode: 'agents' as const, level: 'autofill' as const, agents: ['a'] };
    expect(vc.agentPolicyAllows(policy, { agentId: 'a', level: 'autofill' })).toEqual({ allowed: true });
    expect(vc.agentPolicyAllows(policy, { agentId: 'b', level: 'metadata' }))
      .toEqual({ allowed: false, reason: 'This agent is not allowed to use this item' });
    expect(vc.agentPolicyAllows(policy, { agentId: 'a', level: 'full' }))
      .toEqual({ allowed: false, reason: 'Agents are limited to autofill' });
    expect(vc.agentPolicyAllows({ ...policy, sites: ['example.com'] }, { agentId: 'a', level: 'metadata', host: 'example.com:443' }))
      .toEqual({ allowed: false, reason: 'A valid destination host is required by this item policy' });
    expect(vc.agentPolicyAllows(null, { agentId: 'a', level: 'metadata' }))
      .toEqual({ allowed: false, reason: 'Only the owner can use this item' });
  });
});
