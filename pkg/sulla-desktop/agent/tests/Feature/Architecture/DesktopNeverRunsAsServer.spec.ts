// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Business rule: Desktop never runs as a server (M8, 2026-11-12). Sulla Server lives in merchantprotocol/sulla-server.
 * Desktop services accept only `desktop` mode; a hosted server mode, its bootstrap CLI, its UI and the hosted vault
 * console must not come back into Desktop source (services/** and pkg/**).
 *
 * Desktop acting as a CLIENT of an org server stays legal and is NOT flagged: Files roots `syncMode: 'server'`,
 * main/serverEnrollment/**, main/cloud/**, `SULLA_AGENT_MODE=transport`, `config.serverUrl`.
 */
class ServerModeGuard {
  private static readonly SERVICE_MODES = 'SULLA_(?:VAULT|FILES|AGENT_SERVICE|WORKFLOW|ACCOUNTS)_MODE';
  private static readonly TEXT_FILE = /\.(?:ts|mts|cts|js|mjs|cjs|vue|sh|ya?ml|json)$|(?:^|\/)Dockerfile[^/]*$/;
  private static readonly FORBIDDEN_FILE = /(?:^|\/)(?:serverBootstrap[^/]*|serverUi[^/]*)$|^services\/sulla-vault\/console\/(?!local\/)/;
  /** Source the rule does not read: Desktop-as-client code owned by other epics, test fixtures, migrations, build output. */
  private static readonly EXCLUDED = [
    /^pkg\/sulla-desktop\/main\/serverEnrollment\//,
    /^pkg\/sulla-desktop\/main\/cloud\//,
    /(?:^|\/)(?:tests?|__tests__|fixtures|migrations|dist|node_modules)\//,
    /\.(?:spec|test)\.[cm]?[jt]s$/,
  ];

  private static readonly PATTERNS: readonly { name: string; pattern: RegExp }[] = [
    // SULLA_X_MODE === 'server', SULLA_X_MODE=server, SULLA_X_MODE: "server", env.SULLA_X_MODE ?? 'server'
    { name: 'service mode env set to server', pattern: new RegExp(`${ ServerModeGuard.SERVICE_MODES }[^\\n]{0,60}?(?:===?|!==?|[:=]|\\?\\?|\\|\\|)\\s*['"]?server\\b`) },
    // `mode === 'server'` / `mode: 'server'` style mode values
    { name: 'mode value server', pattern: /\bmode\s*(?:===?|!==?|:)\s*['"]server['"]/ },
  ];

  /**
   * Services still carrying hosted server mode because their removal PR has not merged yet.
   * TEMPORARY: remove when #2257 merges (M8 D2, files service).
   */
  private static readonly TEMPORARY_ALLOWLIST: readonly string[] = [
    'services/sulla-files/',
  ];

  constructor(private readonly root: string, private readonly allowlist: readonly string[] = ServerModeGuard.TEMPORARY_ALLOWLIST) {}

  /** Tracked files under services/ and pkg/ the guard looks at. */
  files(): string[] {
    return execFileSync('git', ['ls-files', '-z', 'services', 'pkg'], { cwd: this.root, maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8').split('\0').filter(Boolean)
      .filter(file => !ServerModeGuard.EXCLUDED.some(rule => rule.test(file)))
      .filter(file => !this.allowlist.some(prefix => file.startsWith(prefix)))
      .sort();
  }

  /** `file` for every forbidden filename. */
  forbiddenFiles(): string[] {
    return this.files().filter(file => ServerModeGuard.FORBIDDEN_FILE.test(file));
  }

  /** `file:line  code` for every server-mode switch in tracked source. */
  modeViolations(): string[] {
    return this.files()
      .filter(file => ServerModeGuard.TEXT_FILE.test(file))
      .flatMap(file => this.modeSwitchesIn(readFileSync(path.join(this.root, file), 'utf8')).map(hit => `${ file }:${ hit }`));
  }

  /** `line  code` for each server-mode switch in one source text. */
  modeSwitchesIn(source: string): string[] {
    return source.split('\n').flatMap((text, index) => (
      ServerModeGuard.PATTERNS.some(rule => rule.pattern.test(text)) ? [`${ index + 1 }  ${ text.trim() }`] : []
    ));
  }

  isForbiddenFile(file: string): boolean {
    return ServerModeGuard.FORBIDDEN_FILE.test(file);
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../');
const guard = new ServerModeGuard(repoRoot);

describe('Desktop never runs as a server', () => {
  it('risk: server mode creeping back. no service reads or sets a server mode', () => { // risk: Desktop silently hosts org data
    expect(guard.modeViolations()).toEqual([]);
  });

  it('risk: server mode creeping back. no server bootstrap, server UI or hosted vault console files', () => {
    expect(guard.forbiddenFiles()).toEqual([]);
  });

  it('flags every way of enabling server mode for each of the five services', () => {
    for (const service of ['VAULT', 'FILES', 'AGENT_SERVICE', 'WORKFLOW', 'ACCOUNTS']) {
      const name = `SULLA_${ service }_MODE`;
      for (const code of [
        `if (process.env.${ name } === 'server') {}`,
        `const mode = process.env.${ name } ?? 'server';`,
        `${ name }=server node index.js`,
        `  ${ name }: "server"`,
        `env.${ name } !== "server"`,
      ]) {
        expect(guard.modeSwitchesIn(code), code).toHaveLength(1);
      }
    }
    expect(guard.modeSwitchesIn("if (mode === 'server') start();")).toHaveLength(1);
  });

  it('does not flag Desktop acting as a client of an org server', () => {
    for (const code of [
      "return { id: 'default', syncMode: 'server', paused: false };",
      "const syncMode = value === 'server' ? 'server' : 'local';",
      "SULLA_AGENT_MODE: 'transport',",
      'SULLA_VAULT_MODE: desktop',
      "SULLA_VAULT_MODE: 'desktop',",
      "if ((process.env.SULLA_ACCOUNTS_MODE ?? 'desktop') !== 'desktop') throw new Error('Server mode requires Sulla Server');",
      'const url = config.serverUrl;',
      "location: r.location === 'server' ? 'server' : 'desktop',",
    ]) {
      expect(guard.modeSwitchesIn(code), code).toEqual([]);
    }
  });

  it('flags server bootstrap and UI filenames and spares client paths', () => {
    expect(guard.isForbiddenFile('services/sulla-vault/src/serverBootstrapCli.ts')).toBe(true);
    expect(guard.isForbiddenFile('services/sulla-files/src/serverUi.ts')).toBe(true);
    expect(guard.isForbiddenFile('services/sulla-vault/console/org/index.html')).toBe(true);
    expect(guard.isForbiddenFile('services/sulla-vault/console/local/index.html')).toBe(false);
    expect(guard.isForbiddenFile('pkg/sulla-desktop/main/serverEnrollment/ServerEnrollmentClient.ts')).toBe(false);
  });
});
