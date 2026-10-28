// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, jest } from '@jest/globals';

const session = { setCertificateVerifyProc: jest.fn(), fetch: jest.fn() };

jest.unstable_mockModule('electron', () => ({
  default: { session: { fromPartition: jest.fn(() => session) } },
}));
jest.unstable_mockModule('node:fs/promises', () => ({
  default: { readFile: jest.fn(() => Promise.resolve(`${ 'ab'.repeat(32) }\n`)) },
}));
jest.unstable_mockModule('@pkg/utils/paths', () => ({ default: { appHome: '/app-home' } }));
jest.unstable_mockModule('../vaultTlsVerifier', () => ({ verifyVaultCertificate: jest.fn(() => true) }));

const { desktopFilesFetch, refreshFilesPinnedSessions } = await import('../sullaFilesTls');

describe('Files pinned sessions', () => {
  it('reconfigures a session once per refresh, however many refreshes ran before', async() => {
    // Creating the transport registers the one Files session.
    await desktopFilesFetch('https://127.0.0.1:30124/healthz');

    const callsPerRefresh: number[] = [];

    for (let i = 0; i < 8; i++) {
      session.setCertificateVerifyProc.mockClear();
      await refreshFilesPinnedSessions();
      callsPerRefresh.push(session.setCertificateVerifyProc.mock.calls.length);
    }

    // Each configure() sets the verifier twice (fail closed, then the pin). The tracked set used to
    // double on every refresh (2, 4, 8, ...), reaching 2^21 entries after 21 refreshes.
    expect(callsPerRefresh).toEqual(Array(8).fill(2));
  });
});
