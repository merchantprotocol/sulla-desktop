// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Finds raw Sulla Cloud /auth/ requests in main-process source: a `cloudFetch`, `cloudRequest` or `fetch` call whose
 * first argument is a string or template literal containing `/auth/`. Every such call belongs in
 * ElectronCloudAccountTransport (D-ID-1), so one class owns the auth wire format, errors and retries.
 */
class AuthCallSiteScanner {
  private static readonly RAW_AUTH_CALL = /\b(?:cloudFetch|cloudRequest|fetch)\s*\(\s*[`'"][^`'"]*\/auth\//g;
  private static readonly SOURCE = /\.(?:ts|js|mts|cts)$/;

  constructor(private readonly root: string, private readonly allowed: readonly string[]) {}

  /** Every main-process source file the scan reads, relative to the root. */
  files(): string[] {
    return this.walk(this.root).map(file => path.relative(this.root, file).split(path.sep).join('/')).sort();
  }

  /** `file:line  code` for each raw /auth/ call outside the allowed files. */
  violations(): string[] {
    return this.files()
      .filter(file => !this.allowed.includes(file))
      .flatMap(file => AuthCallSiteScanner.callsIn(readFileSync(path.join(this.root, file), 'utf8')).map(call => `${ file }:${ call }`));
  }

  /** `line  code` for each raw /auth/ call in one source text. */
  static callsIn(source: string): string[] {
    return [...source.matchAll(AuthCallSiteScanner.RAW_AUTH_CALL)].map((match) => {
      const line = source.slice(0, match.index).split('\n').length;
      return `${ line }  ${ match[0] }`;
    });
  }

  private walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : this.walk(full);
      return AuthCallSiteScanner.SOURCE.test(entry.name) && !/\.(?:spec|test)\.[cm]?[jt]s$/.test(entry.name) ? [full] : [];
    });
  }
}

const mainRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../main');
const scanner = new AuthCallSiteScanner(mainRoot, [
  'cloud/account/ElectronCloudAccountTransport.ts',
  'cloud/account/SullaCloudHttpClient.ts',
]);

describe('D-ID-1 every Sulla Cloud /auth/ call goes through ElectronCloudAccountTransport', () => {
  it('risk: sign-in drift. no main-process file outside the transport builds a raw /auth/ request', () => {
    const files = scanner.files();
    // The scan must cover the files that used to hold raw /auth/ calls, or a pass would mean nothing.
    expect(files).toContain('sullaCloudAuth.ts');
    expect(files).toContain('firstRun/pendingCredentials.ts');
    expect(files).toContain('cloud/session/DesktopCloudSessionRefreshers.ts');

    expect(scanner.violations()).toEqual([]);
  });

  it('risk: sign-in drift. the detector catches each raw call form and ignores non-auth and transport-routed calls', () => {
    const source = [
      "const a = await cloudFetch('/auth/logout', { method: 'POST' });",
      'const b = await fetch(`${ API_BASE }/auth/refresh`, init);',
      "const c = await fetch('https://sulla-workers.merchantprotocol.workers.dev/auth/refresh', init);",
      'const d = await cloudRequest("/auth/me");',
      "const e = await cloudFetch('/devices', init);",
      "const f = await accountTransport.logout({ refreshToken });",
      "// see POST /auth/logout",
    ].join('\n');

    expect(AuthCallSiteScanner.callsIn(source).map(call => call.split('  ')[0])).toEqual(['1', '2', '3', '4']);
  });
});
