export type VaultCredentialErrorCode = 'INVALID_VAULT_ROW' | 'VAULT_DECRYPT_FAILED';

export interface VaultCredentialError {
  code:    VaultCredentialErrorCode;
  message: string;
}

export interface VaultCredentialValue {
  value_id:       number;
  integration_id: string;
  account_id:     string;
  property:       string;
  value:          string;
  is_default:     boolean;
  created_at:     string | null;
  updated_at:     string | null;
}

export interface VaultCredentialReadResult {
  success: boolean;
  values?: VaultCredentialValue[];
  error?:  VaultCredentialError;
}

const asString = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
};

const asTimestamp = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return asString(value);
};

export function normalizeVaultCredentialValue(raw: unknown): VaultCredentialValue | VaultCredentialError {
  if (!raw || typeof raw !== 'object') {
    return { code: 'INVALID_VAULT_ROW', message: 'Vault row is not an object.' };
  }

  const row = raw as Record<string, unknown>;
  const valueId = typeof row.value_id === 'number' ? row.value_id : Number(row.value_id);
  const integrationId = asString(row.integration_id);
  const accountId = asString(row.account_id);
  const property = asString(row.property);
  const value = asString(row.value);

  if (!Number.isSafeInteger(valueId) || !integrationId || !accountId || !property || value === null) {
    return { code: 'INVALID_VAULT_ROW', message: 'Vault row has an invalid credential shape.' };
  }

  return {
    value_id:       valueId,
    integration_id: integrationId,
    account_id:     accountId,
    property,
    value,
    is_default:     row.is_default === true || row.is_default === 'true' || row.is_default === 1,
    created_at:     asTimestamp(row.created_at),
    updated_at:     asTimestamp(row.updated_at),
  };
}

export function normalizeVaultCredentialValues(rawValues: unknown[]): VaultCredentialReadResult {
  const values: VaultCredentialValue[] = [];
  for (const raw of rawValues) {
    const normalized = normalizeVaultCredentialValue(raw);
    if ('code' in normalized) return { success: false, error: normalized };
    values.push(normalized);
  }
  return { success: true, values };
}

export function isVaultCredentialError(value: VaultCredentialValue | VaultCredentialError): value is VaultCredentialError {
  return 'code' in value;
}
