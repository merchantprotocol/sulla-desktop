// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Regenerates vault-sync-v3-kat.json, the cross-implementation fixture for
// Passwords sync v3. The "desktop" half is produced by this service's
// envelope.ts with @sulla/vault-crypto (exactly what the container uploads);
// the "browser" half by www-sulladesktop js/cloud/passwords/sync-envelope.js
// (exactly what the Passwords crypto worker commits). Each side's test must
// verify and decrypt the other side's half. Synthetic data only.
//
//   node kat-fixture.mjs <path-to-www>/js/cloud/passwords/sync-envelope.js <out.json>
//
// Needs esbuild and libsodium-wrappers-sumo resolvable from the cwd.
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [browserModule, out] = process.argv.slice(2);
if (!browserModule || !out) throw new Error('usage: node kat-fixture.mjs <sync-envelope.js> <out.json>');
const here = path.dirname(fileURLToPath(import.meta.url));
const bundled = await build({
  stdin: {
    contents: `
      export * as desktop from ${ JSON.stringify(path.join(here, 'envelope.ts')) };
      export * as browser from ${ JSON.stringify(path.resolve(browserModule)) };
      export * as vc from '@sulla/vault-crypto';
      export { default as sodium } from 'libsodium-wrappers-sumo';
    `,
    resolveDir: process.cwd(), loader: 'ts',
  },
  alias: { '@sulla/vault-crypto': path.join(here, '../../../../packages/vault-crypto/src/index.ts') },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent', external: ['libsodium-wrappers-sumo'],
});
const tmp = path.join(path.dirname(path.resolve(out)), `.kat-${ process.pid }.mjs`);
writeFileSync(tmp, bundled.outputFiles[0].text);
const { desktop, browser, vc, sodium } = await import(tmp);
(await import('node:fs')).unlinkSync(tmp);
await sodium.ready;

const PASSWORD = 'correct horse battery staple · sync v3';
const PARAMS = { memoryBytes: 64 * 1024 * 1024, operations: 2 };
const VAULT_USER = '9a1c3f00-0000-4000-8000-00000000c0de';

async function half(kind) {
  const env = kind === 'desktop' ? desktop.createSyncEnvelope(sodium) : browser.createSyncEnvelope(sodium);
  const master = await vc.deriveMasterKey(PASSWORD, undefined, PARAMS);
  const { userKey, encryptedUserKey } = await vc.createUserKey(master.key);
  const pair = await vc.createUserKeyPair(userKey);
  const vaultId = kind === 'desktop' ? '0d5e0000-0000-4000-8000-0000000000d1' : '0b40000e-0000-4000-8000-0000000000b1';
  const bundle = env.buildBundle({
    vaultId, vaultUserId: VAULT_USER, epoch: 1, bundleGeneration: 1,
    kdf: { alg: 'argon2id13', salt: master.salt, memoryBytes: PARAMS.memoryBytes, ops: PARAMS.operations },
    encryptedUserKey, publicKey: pair.publicKey, encryptedPrivateKey: pair.encryptedPrivateKey,
  }, userKey);
  const plaintexts = {};
  const records = [];
  const items = [
    { type: 'login', name: `${ kind } bank`, username: 'fixture@example.test', password: 'p@ss-' + kind, uris: [{ uri: 'https://bank.example.test' }], agentPolicy: vc.DEFAULT_AGENT_POLICY },
    { type: 'note', name: `${ kind } note`, notes: 'synthetic only', favorite: true, folder: 'Fixtures', agentPolicy: vc.DEFAULT_AGENT_POLICY },
  ];
  for (const [i, item] of items.entries()) {
    const id = `${ kind === 'desktop' ? 'd' : 'b' }0000000-0000-4000-8000-00000000000${ i + 1 }`;
    const json = JSON.stringify(item);
    plaintexts[id] = json;
    const sealed = kind === 'desktop'
      ? await vc.encryptItem(json, userKey, { itemId: id, ownerId: VAULT_USER })
      : env.encryptItem(json, userKey, VAULT_USER, id);
    records.push(env.buildRecord({ vaultId, scope: 'personal', kind: 'item', id, generation: i + 1, deleted: false, item: sealed }, userKey));
  }
  records.push(env.buildRecord({ vaultId, scope: 'personal', kind: 'item', id: `${ kind === 'desktop' ? 'd' : 'b' }0000000-0000-4000-8000-0000000000ff`, generation: 3, deleted: true }, userKey));
  const head = env.buildHead({ vaultId, scope: 'personal', seq: 4, records, prevHeadMac: '' }, userKey);
  userKey.fill(0);
  master.key.fill(0);
  return { bundle, records, head, plaintexts };
}

writeFileSync(out, `${ JSON.stringify({
  note: 'Synthetic Passwords sync v3 known-answer fixture. Regenerate with services/sulla-vault/src/browserEnvelope/kat-fixture.mjs in sulla-desktop.',
  password: PASSWORD, desktop: await half('desktop'), browser: await half('browser'),
}, null, 2) }\n`);
console.log(`wrote ${ out }`);
