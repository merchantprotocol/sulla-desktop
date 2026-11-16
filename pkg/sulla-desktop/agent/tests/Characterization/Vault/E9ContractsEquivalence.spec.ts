// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * E9 contracts slice: the vault wire contract keeps every runtime export with
 * byte-identical output. The bootstrap and cache-update proof inputs feed
 * HMACs and session-key derivation on both peers (Desktop main + vault), so a
 * single changed character would break unlock. Each case compares the module
 * under test against a frozen legacy copy taken at ddbe28884.
 */
import { describe, expect, it } from 'vitest';

import * as current from '../../../../../../services/sulla-vault/src/contracts';
import * as legacy from '../../Support/E9Legacy/contracts.legacy';

type ProofFn = (...args: any[]) => string;

const RUNTIME_EXPORTS = [
  'BOOTSTRAP_PROTOCOL_VERSION',
  'BOOTSTRAP_HMAC_KEY_ENCODING',
  'bootstrapChallengeProofInput',
  'bootstrapServerProofInput',
  'bootstrapSessionKeyInput',
  'bootstrapUnlockProofInput',
  'cacheUpdateChallengeProofInput',
  'cacheUpdateServerProofInput',
  'cacheUpdateSessionKeyInput',
  'cacheUpdateFetchProofInput',
] as const;

// Realistic and hostile values: separators inside ids, unicode, empty strings,
// numeric edge cases (0, negative, fractional, NaN, Infinity, > 2^53).
const CALLERS = ['sulla-desktop-main', '', 'caller:with:colons', 'ünïcødé-🔐', ' spaced '];
const NONCES = ['AAAAAAAAAAAAAAAAAAAAAA', '', 'nonce/with+base64=', '-'];
const CHALLENGES = ['3f1c2a9e-1111-4222-8333-944445555666', '', 'id:with:colons'];
const EXPIRIES = [1_794_834_392_602, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60];
const SHAS = ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '', '-', 'sha:with:colons'];

function twoArgCases(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const caller of CALLERS) for (const nonce of NONCES) out.push([caller, nonce]);
  return out;
}

function fiveArgCases(): Array<[string, string, string, string, number]> {
  const out: Array<[string, string, string, string, number]> = [];
  for (const caller of CALLERS) {
    for (const nonce of NONCES) {
      for (const challenge of CHALLENGES) {
        for (const expiresAt of EXPIRIES) out.push([caller, nonce, NONCES[(nonce.length + 1) % NONCES.length], challenge, expiresAt]);
      }
    }
  }
  return out;
}

describe('E9 contracts: runtime exports are unchanged', () => {
  it('exposes exactly the same runtime export names as the legacy module', () => {
    // risk: a dropped re-export breaks Desktop main / vault callers at runtime.
    expect(Object.keys(current).sort()).toEqual(Object.keys(legacy).sort());
    expect(Object.keys(current).sort()).toEqual([...RUNTIME_EXPORTS].sort());
  });

  it('keeps the bootstrap protocol constants byte-identical', () => {
    // risk: auth — both peers must agree on protocol version and HMAC key encoding.
    expect(current.BOOTSTRAP_PROTOCOL_VERSION).toBe(legacy.BOOTSTRAP_PROTOCOL_VERSION);
    expect(current.BOOTSTRAP_HMAC_KEY_ENCODING).toBe(legacy.BOOTSTRAP_HMAC_KEY_ENCODING);
    expect(current.BOOTSTRAP_PROTOCOL_VERSION).toBe(1);
    expect(current.BOOTSTRAP_HMAC_KEY_ENCODING).toBe('utf8-base64url-token-string');
  });
});

describe('E9 contracts: proof-input builders match legacy for every input', () => {
  const twoArg = ['bootstrapChallengeProofInput', 'cacheUpdateChallengeProofInput'] as const;
  const fiveArg = ['bootstrapServerProofInput', 'bootstrapSessionKeyInput', 'cacheUpdateServerProofInput', 'cacheUpdateSessionKeyInput'] as const;

  for (const name of twoArg) {
    it(`${ name } is identical to legacy`, () => {
      // risk: auth — a changed HMAC input string silently breaks bootstrap unlock.
      const next = current[name] as ProofFn;
      const old = legacy[name] as ProofFn;
      for (const args of twoArgCases()) expect(next(...args)).toBe(old(...args));
    });
  }

  for (const name of fiveArg) {
    it(`${ name } is identical to legacy`, () => {
      // risk: auth / key derivation — domain-separated session key inputs.
      const next = current[name] as ProofFn;
      const old = legacy[name] as ProofFn;
      for (const args of fiveArgCases()) expect(next(...args)).toBe(old(...args));
    });
  }

  it('bootstrapUnlockProofInput is identical to legacy', () => {
    // risk: auth — the unlock proof binds the sealed master-key payload hash.
    for (const args of fiveArgCases()) {
      for (const sha of SHAS) expect(current.bootstrapUnlockProofInput(...args, sha)).toBe(legacy.bootstrapUnlockProofInput(...args, sha));
    }
  });

  it('cacheUpdateFetchProofInput is identical to legacy, including the default sealedLegacySha256', () => {
    // risk: auth — the '-' default must survive; undefined must also map to it.
    for (const args of fiveArgCases()) {
      expect(current.cacheUpdateFetchProofInput(...args)).toBe(legacy.cacheUpdateFetchProofInput(...args));
      expect(current.cacheUpdateFetchProofInput(...args, undefined)).toBe(legacy.cacheUpdateFetchProofInput(...args, undefined));
      for (const sha of SHAS) expect(current.cacheUpdateFetchProofInput(...args, sha)).toBe(legacy.cacheUpdateFetchProofInput(...args, sha));
    }
  });

  it('pins the exact known-answer strings', () => {
    // risk: auth — hardcoded known answers so a matching change to both copies is still caught.
    const a: [string, string, string, string, number] = ['caller', 'cn', 'sn', 'chal', 42];
    expect(current.bootstrapChallengeProofInput('caller', 'cn')).toBe('challenge:caller:cn');
    expect(current.bootstrapServerProofInput(...a)).toBe('server:caller:cn:sn:chal:42');
    expect(current.bootstrapSessionKeyInput(...a)).toBe('session:caller:cn:sn:chal:42');
    expect(current.bootstrapUnlockProofInput(...a, 'abc')).toBe('unlock:caller:cn:sn:chal:42:abc');
    expect(current.cacheUpdateChallengeProofInput('caller', 'cn')).toBe('cache-challenge:caller:cn');
    expect(current.cacheUpdateServerProofInput(...a)).toBe('cache-server:caller:cn:sn:chal:42');
    expect(current.cacheUpdateSessionKeyInput(...a)).toBe('cache-session:caller:cn:sn:chal:42');
    expect(current.cacheUpdateFetchProofInput(...a)).toBe('cache-fetch:caller:cn:sn:chal:42:-');
    expect(current.cacheUpdateFetchProofInput(...a, 'abc')).toBe('cache-fetch:caller:cn:sn:chal:42:abc');
  });
});
