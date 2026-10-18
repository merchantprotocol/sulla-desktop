/** @jest-environment node */
import { describe, expect, jest, test } from '@jest/globals';

let publicPin = 'a'.repeat(64);
const verify = jest.fn((_hostname: string, _certificate: string, expected: string) => expected === publicPin);
jest.unstable_mockModule('node:fs/promises', () => ({ default: { readFile: jest.fn(() => Promise.resolve(publicPin)) } }));
jest.unstable_mockModule('@pkg/utils/paths', () => ({ default: { appHome: '/unused' } }));
jest.unstable_mockModule('../vaultTlsVerifier', () => ({ verifyVaultCertificate: verify, vaultCertificateMetadataMatches: jest.fn() }));
jest.unstable_mockModule('electron', () => ({ default: {} }));

describe('vault TLS pin rotation', () => {
  test('refreshes an already-configured control session after provisioning changes the pin', async() => {
    const { configureVaultPinnedSession, refreshVaultPinnedSessions } = await import('../vaultTls');
    type Verifier = (request: { hostname: string; certificate: { data: string } }, callback: (result: number) => void) => void;
    let verifier: Verifier | undefined;
    const session = { setCertificateVerifyProc: jest.fn((value: Verifier) => { verifier = value }) };
    await configureVaultPinnedSession(session as unknown as Electron.Session);
    publicPin = 'b'.repeat(64);
    await refreshVaultPinnedSessions();
    const callback = jest.fn();
    verifier!({ hostname: '127.0.0.1', certificate: { data: 'public certificate' } }, callback);
    expect(callback).toHaveBeenCalledWith(0);
    expect(verify).toHaveBeenLastCalledWith('127.0.0.1', 'public certificate', publicPin);
    expect(session.setCertificateVerifyProc).toHaveBeenCalledTimes(4);
  });

  test('refuses an invalid replacement pin rather than accepting arbitrary TLS', async() => {
    const { configureVaultPinnedSession, refreshVaultPinnedSessions } = await import('../vaultTls');
    publicPin = 'c'.repeat(64);
    await refreshVaultPinnedSessions();
    type Verifier = (request: { hostname: string; certificate: { data: string } }, callback: (result: number) => void) => void;
    let verifier: Verifier | undefined;
    const session = { setCertificateVerifyProc: jest.fn((value: Verifier) => { verifier = value }) };
    await configureVaultPinnedSession(session as unknown as Electron.Session);
    publicPin = 'invalid';
    await expect(refreshVaultPinnedSessions()).rejects.toThrow('missing or invalid');
    const callback = jest.fn();
    verifier!({ hostname: '127.0.0.1', certificate: { data: 'previous public certificate' } }, callback);
    expect(callback).toHaveBeenCalledWith(-2);
  });
});
