// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Finds call sites in main-process source that match any of the given patterns, outside an allow-list of files.
 * D-ID-1: raw Sulla Cloud /auth/ requests (a `cloudFetch`, `cloudRequest` or `fetch` call whose first argument is a
 * string or template literal containing `/auth/`). D-ID-4b: anything that could send /auth/logout around the transport.
 * Every such call belongs in ElectronCloudAccountTransport, so one class owns the auth wire format, errors and retries.
 */
class CallSiteScanner {
  private static readonly SOURCE = /\.(?:ts|js|mts|cts)$/;

  constructor(private readonly root: string, private readonly allowed: readonly string[], private readonly patterns: readonly RegExp[]) {}

  /** Every main-process source file the scan reads, relative to the root. */
  files(): string[] {
    return this.walk(this.root).map(file => path.relative(this.root, file).split(path.sep).join('/')).sort();
  }

  /** `file:line  code` for each matching call outside the allowed files. */
  violations(): string[] {
    return this.files()
      .filter(file => !this.allowed.includes(file))
      .flatMap(file => this.callsIn(readFileSync(path.join(this.root, file), 'utf8')).map(call => `${ file }:${ call }`));
  }

  /** `line  code` for each match in one source text, in source order. */
  callsIn(source: string): string[] {
    return this.patterns
      .flatMap(pattern => [...source.matchAll(new RegExp(pattern.source, 'g'))])
      .sort((a, b) => a.index - b.index)
      .map((match) => {
        const line = source.slice(0, match.index).split('\n').length;
        return `${ line }  ${ match[0] }`;
      });
  }

  private walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : this.walk(full);
      return CallSiteScanner.SOURCE.test(entry.name) && !/\.(?:spec|test)\.[cm]?[jt]s$/.test(entry.name) ? [full] : [];
    });
  }
}

const mainRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../main');
const scanner = new CallSiteScanner(mainRoot, [
  'cloud/account/ElectronCloudAccountTransport.ts',
  'cloud/account/SullaCloudHttpClient.ts',
], [/\b(?:cloudFetch|cloudRequest|fetch)\s*\(\s*[`'"][^`'"]*\/auth\//]);

/**
 * D-ID-4b: sign-out revokes through SignOutService -> CloudAccountTransport.logout, and the only Desktop transport is
 * ElectronCloudAccountTransport. Outside it, nothing may name the /auth/logout path, build its own logout/refresh
 * sender, swap the transport's sender through the `logoutHttp`/`refreshHttp` test seams, or implement a second
 * CloudAccountTransport that SignOutService could be handed.
 */
const logoutScanner = new CallSiteScanner(mainRoot, ['cloud/account/ElectronCloudAccountTransport.ts'], [
  /[`'"](?:\$\{[^}]*\}|[\w:./-])*\/auth\/logout/,
  /\bnew\s+FetchCloud(?:Logout|Refresh)Http\s*\(/,
  /\b(?:logoutHttp|refreshHttp)\s*:/,
  /\bimplements\b[^{]*\bCloudAccountTransport\b/,
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

    expect(scanner.callsIn(source).map(call => call.split('  ')[0])).toEqual(['1', '2', '3', '4']);
  });
});

describe('D-ID-4b sign-out reaches /auth/logout only through ElectronCloudAccountTransport', () => {
  it('risk: session left alive. no main-process file outside the transport can send /auth/logout around it', () => {
    const files = logoutScanner.files();
    // The files that held the old logout sender (D-ID-4) and the sign-out wiring must be scanned.
    expect(files).toContain('sullaCloudAuth.ts');
    expect(files).toContain('cloud/session/DesktopCloudSessionRefreshers.ts');
    expect(files).toContain('cloud/session/DesktopCloudSignOut.ts');

    expect(logoutScanner.violations()).toEqual([]);
  });

  it('risk: session left alive. the detector catches each logout bypass form and ignores routed calls and comments', () => {
    const source = [
      "new FetchCloudLogoutHttp(refreshToken => cloudFetch('/auth/logout', init));",
      'const url = `${ API_BASE }/auth/logout`;',
      "const t = new ElectronCloudAccountTransport({ logoutHttp: custom });",
      'class OtherTransport implements CloudAccountTransport {',
      "const r = new FetchCloudRefreshHttp(send);",
      "await accountTransport.logout({ refreshToken });",
      "new SignOutService(sessions, store, lock, accountTransport, revocations, [], events);",
      "// POSTs /auth/logout once, after the local clear",
    ].join('\n');

    expect(logoutScanner.callsIn(source).map(call => call.split('  ')[0])).toEqual(['1', '1', '2', '3', '4', '5']);
  });
});
