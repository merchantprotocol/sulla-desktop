// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import { verifyLicenseToken } from './license.js';

const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function fixture(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const header = enc({ alg: 'EdDSA', typ: 'SULLA-SERVER-LICENSE', v: 1 });
  const payload = enc({ iss: 'sulla-cloud', typ: 'server-license', licenseId: 'l', orgId: 'o', serverId: 's', edition: 'community', seatLimit: 25, iat: 1, exp: 4_000_000_000, features: ['use_cases'], ...overrides });
  return { token: `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}
test('verifies signatures and enforces expiry and seats', () => {
  const valid = fixture(); assert.equal(verifyLicenseToken(valid.token, valid.publicKey, { seatCount: 25 }).serverId, 's');
  assert.throws(() => verifyLicenseToken(`${valid.token}x`, valid.publicKey), /signature/);
  assert.throws(() => verifyLicenseToken(valid.token, valid.publicKey, { seatCount: 26 }), /allows 25/);
  const expired = fixture({ exp: 1 }); assert.throws(() => verifyLicenseToken(expired.token, expired.publicKey), /expired/);
});
