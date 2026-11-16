// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, createHmac } from 'crypto';

import { describe, expect, it } from 'vitest';

import { PostgresScramVerifier, ScramVerifierUnsupportedPasswordError } from '@pkg/backend/PostgresScramVerifier';

/** RFC 7677 §3 example exchange (user "user", password "pencil"). */
const RFC = {
  password:    'pencil',
  salt:        Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'),
  authMessage: 'n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,'
    + 'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0',
  clientProof:     'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=',
  serverSignature: '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=',
};

function keysOf(verifier: string) {
  const [, , storedKey, serverKey] = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(verifier) ?? [];

  return { storedKey: Buffer.from(storedKey, 'base64'), serverKey: Buffer.from(serverKey, 'base64') };
}

describe('PostgresScramVerifier', () => {
  // risk: sign-in — a verifier PostgreSQL disagrees with locks every service out
  it('produces a verifier a SCRAM server accepts for the RFC 7677 client proof', () => {
    const verifier = PostgresScramVerifier.create(RFC.password, RFC.salt).toString();
    const { storedKey, serverKey } = keysOf(verifier);
    // What the server does with client-final-message: ClientKey = proof XOR HMAC(StoredKey, AuthMessage); H(ClientKey) must be StoredKey.
    const signature = createHmac('sha256', storedKey).update(RFC.authMessage).digest();
    const clientKey = Buffer.from(Buffer.from(RFC.clientProof, 'base64').map((byte, index) => byte ^ signature[index]));

    expect(createHash('sha256').update(clientKey).digest().equals(storedKey)).toBe(true);
    expect(createHmac('sha256', serverKey).update(RFC.authMessage).digest('base64')).toBe(RFC.serverSignature);
    expect(verifier).toBe('SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=');
  });

  // risk: data accuracy — convergence reads the stored verifier to decide whether ALTER ROLE is needed
  it('matches only the password it was made from, after a round trip through its text form', () => {
    const parsed = PostgresScramVerifier.parse(PostgresScramVerifier.create('Kq3_real-ServiceSecret').toString());

    expect(parsed?.matches('Kq3_real-ServiceSecret')).toBe(true);
    expect(parsed?.matches('Kq3_real-ServiceSecreT')).toBe(false);
    expect(parsed?.matches('')).toBe(false);
  });

  // risk: data accuracy — anything that is not a SCRAM verifier means "not converged"
  it('does not parse md5 hashes, plaintext or truncated verifiers', () => {
    expect(PostgresScramVerifier.parse(null)).toBeNull();
    expect(PostgresScramVerifier.parse('')).toBeNull();
    expect(PostgresScramVerifier.parse('md5c4ca4238a0b923820dcc509a6f75849b')).toBeNull();
    expect(PostgresScramVerifier.parse('sulla_dev_password')).toBeNull();
    expect(PostgresScramVerifier.parse('SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$AAAA:BBBB')).toBeNull();
  });

  // risk: sign-in — PostgreSQL SASLpreps non-ASCII passwords; never guess what it would compute
  it('refuses a password that is not printable ASCII', () => {
    expect(() => PostgresScramVerifier.create('pässwörd')).toThrow(ScramVerifierUnsupportedPasswordError);
    expect(() => PostgresScramVerifier.create('')).toThrow(ScramVerifierUnsupportedPasswordError);
  });

  // risk: secret exposure — two verifiers for one secret must not be linkable
  it('uses a fresh random salt each time', () => {
    expect(PostgresScramVerifier.create('same-secret').toString()).not.toBe(PostgresScramVerifier.create('same-secret').toString());
  });
});
