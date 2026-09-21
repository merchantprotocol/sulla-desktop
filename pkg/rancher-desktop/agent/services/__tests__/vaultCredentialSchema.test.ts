import {
  normalizeVaultCredentialValue,
  normalizeVaultCredentialValues,
} from '../vaultCredentialSchema';

describe('vault credential schema', () => {
  it('normalizes tool-shaped rows into the UI schema without exposing raw model objects', () => {
    const result = normalizeVaultCredentialValue({
      value_id:       '42',
      integration_id: 'website',
      account_id:     'selkirkfoods-jonathon',
      property:       'password',
      value:          'REDACTED_TEST_VALUE',
      is_default:     'true',
      created_at:     new Date('2026-09-20T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      value_id:       42,
      integration_id: 'website',
      account_id:     'selkirkfoods-jonathon',
      property:       'password',
      is_default:     true,
      created_at:     '2026-09-20T00:00:00.000Z',
    });
    expect(result).toHaveProperty('value', 'REDACTED_TEST_VALUE');
  });

  it('returns a typed error for an object value instead of crossing IPC', () => {
    const result = normalizeVaultCredentialValues([{
      value_id:       42,
      integration_id: 'website',
      account_id:     'selkirkfoods-jonathon',
      property:       'password',
      value:          { encrypted: true },
    }]);

    expect(result).toEqual({
      success: false,
      error:   {
        code:    'INVALID_VAULT_ROW',
        message: 'Vault row has an invalid credential shape.',
      },
    });
  });
});
