// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { validateCustomFields } from '../../../../../../packages/vault-crypto/src/customFields';
import { normalizeVaultCredentialValue, normalizeVaultCredentialValues } from '../../../services/vaultCredentialSchema';
import { parseCSV } from '../../../services/vaultImportParsers';

describe('Desktop vault data public contract', () => {
  it('parses RFC 4180 exports without moving multiline secrets between columns', () => {
    // risk: data accuracy — imports must not attach a password to the wrong account.
    expect(parseCSV('\uFEFFname,username,password,notes\r\n"Bank, Inc",alice,"p""ass","line 1\nline 2"\r\n'))
      .toEqual([
        ['name', 'username', 'password', 'notes'],
        ['Bank, Inc', 'alice', 'p"ass', 'line 1\nline 2'],
      ]);
    expect(parseCSV('\n\r\n')).toEqual([]);
  });

  it('normalizes database credential values and rejects a malformed row atomically', () => {
    // risk: data accuracy / secret-to-account association.
    const valid = normalizeVaultCredentialValue({
      value_id: '42', integration_id: 'github', account_id: 7, property: 'token', value: 123,
      is_default: 1, created_at: new Date('2026-01-02T03:04:05Z'), updated_at: null,
    });
    expect(valid).toEqual({
      value_id: 42, integration_id: 'github', account_id: '7', property: 'token', value: '123',
      is_default: true, created_at: '2026-01-02T03:04:05.000Z', updated_at: null,
    });
    expect(normalizeVaultCredentialValues([valid, { value_id: 'NaN' }])).toEqual({
      success: false,
      error: { code: 'INVALID_VAULT_ROW', message: 'Vault row has an invalid credential shape.' },
    });
  });

  it('rejects duplicate custom-field identities and labels while preserving valid encrypted fields', () => {
    // risk: data loss — duplicate identities must not overwrite an encrypted custom field.
    const fields = [
      { id: 'field-1', label: 'Recovery', type: 'password', value: 'synthetic-secret', hidden: true },
      { id: 'field-2', label: 'Region', type: 'text', value: 'west' },
    ];
    expect(validateCustomFields(fields)).toEqual({ ok: true, fields });
    expect(validateCustomFields([...fields, { ...fields[1], id: 'field-3', label: 'region' }])).toEqual({
      ok: false, error: "Custom field 3 label is already used on this item",
    });
    expect(validateCustomFields([...fields, { ...fields[1], label: 'Other' }])).toEqual({
      ok: false, error: "Custom field 3 repeats another field's id",
    });
  });
});
