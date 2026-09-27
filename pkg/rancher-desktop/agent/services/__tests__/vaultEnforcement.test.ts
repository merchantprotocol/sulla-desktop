import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * The enforcement points that sit on top of the vault: agents cannot raise
 * their own access or clobber secrets, capability tokens honor llm_access,
 * and writes fail closed instead of storing plaintext while locked.
 */
const values = new Map<string, string>();
const vaultState = { setUp: true, unlocked: true };

jest.unstable_mockModule('../VaultKeyService', () => ({
  getVaultKeyService: () => ({
    isSetUp:     () => vaultState.setUp,
    isUnlocked:  () => vaultState.unlocked,
    isEncrypted: (v: string) => typeof v === 'string' && v.startsWith('$VAULT$'),
    encrypt:     (v: string) => `$VAULT$${ Buffer.from(v).toString('base64') }`,
    decrypt:     (v: string) => Buffer.from(v.slice(7), 'base64').toString(),
  }),
}));
jest.unstable_mockModule('../../database/PostgresClient', () => ({ postgresClient: {} }));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: async() => null } }));
jest.unstable_mockModule('../../integrations/catalog', () => ({
  integrations: { website: { properties: [{ key: 'password', type: 'password' }, { key: 'username', type: 'text' }] } },
}));
jest.unstable_mockModule('../IntegrationService', () => ({
  getIntegrationService: () => ({
    initialize:          async() => {},
    getIntegrationValue: async(i: string, p: string, a?: string) => {
      const v = values.get(`${ i }/${ a ?? 'default' }/${ p }`);

      return v === undefined ? null : { value: v };
    },
    setIntegrationValue: async(input: any) => {
      values.set(`${ input.integration_id }/${ input.account_id ?? 'default' }/${ input.property }`, input.value);
    },
    setConnectionStatus: async() => {},
  }),
}));

const { IntegrationValueModel, encryptForStorage } = await import('../../database/models/IntegrationValueModel');
const { IntegrationSetCredentialWorker } = await import('../../tools/integrations/integration_set_credential');
const { SecretsCapabilityService, SecretsResolveError } = await import('../SecretsCapabilityService');

beforeEach(() => {
  values.clear();
  vaultState.setUp = true;
  vaultState.unlocked = true;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('vault_set_credential', () => {
  const call = (input: any) => (new IntegrationSetCredentialWorker() as any)._validatedCall(input);

  it('refuses to let the agent raise llm_access', async() => {
    const res = await call({ account_type: 'website', account_id: 'bank', property: 'llm_access', value: 'full' });

    expect(res.successBoolean).toBe(false);
    expect(values.has('website/bank/llm_access')).toBe(false);
  });

  it('refuses to overwrite an existing secret without confirm, allows it with confirm', async() => {
    values.set('website/bank/password', 'original');
    const refused = await call({ account_type: 'website', account_id: 'bank', property: 'password', value: 'clobber' });

    expect(refused.successBoolean).toBe(false);
    expect(values.get('website/bank/password')).toBe('original');

    const ok = await call({ account_type: 'website', account_id: 'bank', property: 'password', value: 'rotated', confirm: true });

    expect(ok.successBoolean).toBe(true);
    expect(values.get('website/bank/password')).toBe('rotated');
  });

  it('still saves new secrets and non-secret fields freely', async() => {
    expect((await call({ account_type: 'github', property: 'api_key', value: 'ghp_new' })).successBoolean).toBe(true);
    values.set('website/bank/username', 'a');
    expect((await call({ account_type: 'website', account_id: 'bank', property: 'username', value: 'b' })).successBoolean).toBe(true);
  });
});

describe('secrets capability honors llm_access', () => {
  function withRows(rows: Record<string, string>) {
    jest.spyOn(IntegrationValueModel, 'findByKey').mockImplementation(async(i, a, p) => {
      const v = rows[`${ i }/${ a }/${ p }`];

      return v === undefined ? null : ({ attributes: { value: v } } as any);
    });
  }

  it.each([
    ['website', undefined, 'access-denied'],
    ['website', 'autofill', 'access-denied'],
    ['website', 'full', 'granted'],
    ['github', undefined, 'granted'],
    ['github', 'none', 'access-denied'],
    ['github', 'metadata', 'access-denied'],
  ])('%s with llm_access=%s → %s', async(integrationId, level, outcome) => {
    const rows: Record<string, string> = { [`${ integrationId }/acct/password`]: 'S3CRET' };

    if (level) rows[`${ integrationId }/acct/llm_access`] = level;
    withRows(rows);
    const svc = new SecretsCapabilityService();
    const { token } = svc.mint({ invocationId: 'inv', refs: { PW: { integrationId, accountId: 'acct', property: 'password' } } });

    try {
      if (outcome === 'granted') {
        await expect(svc.resolve(token, 'PW')).resolves.toBe('S3CRET');
      } else {
        await expect(svc.resolve(token, 'PW')).rejects.toEqual(new SecretsResolveError('access-denied'));
      }
    } finally {
      (svc as any).stopSweepTimer?.();
      clearInterval((svc as any).sweepTimer);
    }
  });
});

describe('IntegrationValueModel.encryptValue fails closed', () => {
  const fakeVault = {
    isSetUp:    () => vaultState.setUp,
    isUnlocked: () => vaultState.unlocked,
    encrypt:    (v: string) => `$VAULT$${ Buffer.from(v).toString('base64') }`,
  };
  const encryptValue = (v: string) => encryptForStorage(v, fakeVault);

  it('encrypts when unlocked and never double-wraps', () => {
    const once = encryptValue('pw');

    expect(once.startsWith('$VAULT$')).toBe(true);
    expect(encryptValue(once)).toBe(once);
  });

  it('throws instead of storing plaintext when the vault exists but is locked', () => {
    vaultState.unlocked = false;
    expect(() => encryptValue('pw')).toThrow('VAULT_LOCKED');
  });

  it('stores as-is only when no vault has ever been configured', () => {
    vaultState.setUp = false;
    vaultState.unlocked = false;
    expect(encryptValue('pw')).toBe('pw');
  });
});
