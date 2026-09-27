/** @jest-environment node */
// Proves the dashboard's in-browser vault unlock (www-sulladesktop
// js/desktop-vault.js) opens exactly what desktopObjectSync uploads,
// using the real VaultKeyService crypto. Skipped if the website checkout
// isn't next to this repo.
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';

import { VaultKeyService } from '@pkg/agent/services/VaultKeyService';

const browserModule = [
  path.resolve(process.cwd(), '../www-ai-employees/js/desktop-vault.js'),
  path.resolve(process.cwd(), '../www-sulladesktop/js/desktop-vault.js'),
].find(p => fs.existsSync(p));

const maybe = browserModule ? test : test.skip;

function loadBrowserVault() {
  const ctx: any = {
    window:   {},
    crypto:   globalThis.crypto,
    TextEncoder,
    TextDecoder,
    atob,
    Uint8Array,
    JSON,
    Number,
    String,
    Error,
    setTimeout,
    clearTimeout,
    document: { addEventListener() {}, removeEventListener() {}, hidden: false },
  };
  vm.runInNewContext(fs.readFileSync(browserModule!, 'utf8'), ctx);
  return ctx.window.SullaDesktopVault;
}

maybe('browser unlock opens a sealed desktop snapshot with the master password or recovery key only', async() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-compat-'));
  const safe = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
  try {
    const svc = new VaultKeyService(dir, safe as any);
    const { recoveryKey } = await svc.setupFromMasterPassword('correct horse battery');
    const rows = [
      { integration_id: 'github', account_id: 'me@example.com', property: 'token', value: svc.encrypt('ghp_secret'), is_default: true },
      { integration_id: 'openai', account_id: 'default', property: 'api_key', value: svc.encrypt('sk-test'), is_default: false },
    ];
    const snapshot = {
      format:      'sulla-vault-snapshot',
      version:     2,
      createdAt:   new Date().toISOString(),
      rowCount:    rows.length,
      keyMaterial: svc.exportKeyMaterial(),
      rows:        [],
      sealed:      svc.encrypt(JSON.stringify(rows)),
    };
    // Nothing identifying is visible to the server.
    const wire = JSON.stringify(snapshot);
    expect(wire).not.toMatch(/github|me@example\.com|ghp_secret|openai/);

    const bv = loadBrowserVault();
    const session = await bv.unlock(JSON.parse(wire), 'correct horse battery', 'password');
    expect(session.rows.map((r: any) => r.integration)).toEqual(['github', 'openai']);
    expect(await session.reveal(session.rows[0])).toBe('ghp_secret');

    const viaRecovery = await bv.unlock(JSON.parse(wire), recoveryKey.toLowerCase().replace(/-/g, ' '), 'recovery');
    expect(await viaRecovery.reveal(viaRecovery.rows[1])).toBe('sk-test');

    await expect(bv.unlock(JSON.parse(wire), 'wrong password', 'password')).rejects.toThrow('does not open');
    session.lock();
    await expect(session.reveal(session.rows[0])).rejects.toThrow('Locked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
