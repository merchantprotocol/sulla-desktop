#!/usr/bin/env node
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Synthetic upgrade smoke for the bundled sulla-vault image.
 *
 * Starts the OLD image (default: the pin on origin/main) in Desktop mode on an
 * empty throwaway PostgreSQL, creates a synthetic vault through the real human
 * HTTP API (first password = setup), saves several synthetic items, then
 * snapshots every items row (sha256 of the full row text) and the users key
 * row (sha256 + xmin + ctid). It stops OLD, starts NEW (default: the pin in
 * packaging/bundled-images.yaml) on the same database so its migrations run,
 * and asserts the rows are untouched, the wrong password is refused with 401,
 * and the right password unlocks and lists/decrypts the same items.
 *
 * Synthetic data only. It never attaches to a real vault database, and it
 * never prints passwords, tokens or item contents.
 *
 * Usage:
 *   node scripts/vault-upgrade-smoke/run.mjs
 * Env:
 *   VAULT_SMOKE_OLD_IMAGE / VAULT_SMOKE_NEW_IMAGE  override the image pair
 *   VAULT_SMOKE_RUNTIME   docker (Docker CLI, default when present) or sulla
 *                         (sulla docker/* tools from inside a Sulla agent container)
 *   VAULT_SMOKE_WORKDIR   scratch dir for TLS + SQL files (must be visible to the
 *                         Docker daemon; required for the sulla runtime)
 *   VAULT_SMOKE_PREFIX    container-name prefix (default vault-smoke-<pid>)
 *   VAULT_SMOKE_KEEP=1    keep containers and scratch for debugging (remove them yourself)
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerCliRuntime, SullaToolRuntime } from './runtime.mjs';
import { SyntheticPostgres } from './repositories/SyntheticPostgres.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PIN_FILE = 'packaging/bundled-images.yaml';
const HUMAN_ORIGIN = 'https://127.0.0.1:30135';
const CONTROL_SERVICE_ID = 'sulla-desktop-control';

/** Reads the sulla-vault pin from a bundled-images.yaml body. */
class VaultPin {
  static parse(text) {
    const match = text.match(/name:\s*sulla-vault,\s*source:\s*([^\s}]+)/);
    if (!match) throw new Error('sulla-vault pin not found in bundled-images.yaml');
    return match[1];
  }

  static current() { return VaultPin.parse(readFileSync(join(REPO_ROOT, PIN_FILE), 'utf8')); }

  static onMain() {
    return VaultPin.parse(execFileSync('git', ['-C', REPO_ROOT, 'show', `origin/main:${ PIN_FILE }`], { encoding: 'utf8' }));
  }
}

/** One Desktop-mode vault container (TLS, five distinct synthetic service tokens). */
class DesktopVaultContainer {
  constructor(runtime, name, image, database, tlsDir, tokens) {
    Object.assign(this, { runtime, name, image, database, tlsDir, tokens });
  }

  start() {
    this.runtime.runDetached(this.name, [
      '-v', `${ this.tlsDir }:/run/sulla-vault-tls:ro`,
      '-e', 'SULLA_VAULT_MODE=desktop',
      '-e', `SULLA_VAULT_PORT=${ VAULT_PORT }`,
      '-e', `SULLA_VAULT_DATABASE_URL=${ this.database.url }`,
      '-e', `SULLA_VAULT_HUMAN_UI_ORIGIN=${ HUMAN_ORIGIN }`,
      '-e', 'SULLA_VAULT_TLS_CERTIFICATE_PATH=/run/sulla-vault-tls/tls.crt',
      '-e', 'SULLA_VAULT_TLS_PRIVATE_KEY_PATH=/run/sulla-vault-tls/tls.key',
      '-e', `SULLA_VAULT_BOOTSTRAP_TOKEN=${ this.tokens.bootstrap }`,
      '-e', `SULLA_VAULT_DESKTOP_CONTROL_TOKEN=${ this.tokens.control }`,
      '-e', `SULLA_VAULT_APPROVAL_TOKEN=${ this.tokens.approval }`,
      '-e', `SULLA_VAULT_BROKER_TOKEN=${ this.tokens.broker }`,
      '-e', `SULLA_VAULT_FILES_TOKEN=${ this.tokens.files }`,
    ], this.image);
  }

  async waitHealthy(client) {
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        if ((await client.request('GET', '/healthz')).status === 200) return;
      } catch { /* starting or migrating */ }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 1000));
    }
    throw new Error(`${ this.image } did not become healthy; last log lines:\n${ this.runtime.logs(this.name) }`);
  }
}

/** HTTPS client for the Desktop human API. Response bodies stay in memory and are never printed. */
class DesktopHumanClient {
  constructor(port, controlToken) {
    this.origin = `https://127.0.0.1:${ port }`;
    this.controlToken = controlToken;
    this.cookie = undefined;
    this.csrf = undefined;
  }

  request(method, path, { body, headers = {} } = {}) {
    return new Promise((resolveRequest, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpsRequest(new URL(path, this.origin), {
        method,
        rejectUnauthorized: false, // synthetic self-signed certificate
        headers: Object.fromEntries(Object.entries({
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(method === 'GET' ? {} : { origin: HUMAN_ORIGIN }),
          ...(this.cookie ? { cookie: this.cookie } : {}),
          ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
          ...headers,
        }).filter(([, value]) => value !== undefined)),
      }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => {
          const setCookie = [response.headers['set-cookie'] ?? []].flat().find(value => value.startsWith('sulla_vault_human='));
          if (setCookie) this.cookie = setCookie.split(';')[0];
          let data = {};
          try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON body */ }
          resolveRequest({ status: response.statusCode ?? 0, data });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async expect(method, path, status, options) {
    const result = await this.request(method, path, options);
    if (result.status !== status) throw new Error(`${ method } ${ path } returned HTTP ${ result.status }, expected ${ status } (${ result.data?.error ?? '' })`);
    if (typeof result.data?.csrf === 'string') this.csrf = result.data.csrf;
    return result.data;
  }

  /** Desktop opens a human session with its control identity, then the page exchanges the grant for a cookie. */
  async openSession() {
    this.cookie = undefined;
    this.csrf = undefined;
    const opened = await this.expect('POST', '/v1/human/session', 200, {
      body:    {},
      headers: { 'x-sulla-service-id': CONTROL_SERVICE_ID, authorization: `Bearer ${ this.controlToken }`, origin: undefined },
    });
    const grant = new URLSearchParams(new URL(opened.url).hash.slice(1));
    return this.expect('POST', '/v1/human/session/exchange', 200, { body: { grant: grant.get('grant'), csrf: grant.get('csrf') } });
  }

  unlock(password) { return this.request('POST', '/v1/human/unlock', { body: { password } }); }

  async unlockOk(password) {
    const result = await this.unlock(password);
    if (result.status !== 200) throw new Error(`unlock returned HTTP ${ result.status } (${ result.data?.error ?? '' })`);
    this.csrf = result.data.csrf;
    return result.data;
  }

  saveItem(item) { return this.expect('POST', '/v1/human/items', 201, { body: { item } }); }

  async listItems() { return (await this.expect('GET', '/v1/human/items', 200)).items; }

  reveal(itemId) { return this.expect('POST', `/v1/human/items/${ itemId }/reveal`, 200, { body: {} }); }
}

/** Synthetic fixture items: one per common type, each with a distinct secret we can check after reveal. */
class SyntheticItems {
  static all() {
    const policy = { mode: 'only_me', level: 'metadata', agents: [], sites: [], expiresAt: null };
    return [
      { type: 'login', name: 'Synthetic login', username: 'synthetic.user@example.com', password: `syn-${ randomBytes(9).toString('hex') }`, uris: [{ uri: 'https://example.com' }], agentPolicy: policy },
      { type: 'secure_note', name: 'Synthetic note', notes: `syn-note-${ randomBytes(9).toString('hex') }`, agentPolicy: policy },
      { type: 'card', name: 'Synthetic card', card: { holder: 'Synthetic Holder', number: '4111111111111111', expMonth: '12', expYear: '2030', code: '123' }, agentPolicy: policy },
      { type: 'login', name: 'Synthetic API key', username: 'synthetic-api', password: `syn-${ randomBytes(9).toString('hex') }`, agentPolicy: policy },
    ];
  }
}

class VaultUpgradeSmoke {
  constructor(env = process.env) {
    this.oldImage = env.VAULT_SMOKE_OLD_IMAGE || VaultPin.onMain();
    this.newImage = env.VAULT_SMOKE_NEW_IMAGE || VaultPin.current();
    if (this.oldImage === this.newImage) throw new Error(`OLD and NEW are the same image (${ this.newImage }); set VAULT_SMOKE_OLD_IMAGE`);
    const runtimeName = env.VAULT_SMOKE_RUNTIME || (this.onPath('docker') ? 'docker' : 'sulla');
    this.runtime = runtimeName === 'sulla' ? new SullaToolRuntime() : new DockerCliRuntime();
    if (runtimeName === 'sulla' && !env.VAULT_SMOKE_WORKDIR) throw new Error('VAULT_SMOKE_WORKDIR (a Docker-daemon-visible path) is required for the sulla runtime');
    this.prefix = env.VAULT_SMOKE_PREFIX || `vault-smoke-${ process.pid }`;
    this.ownsWorkdir = !env.VAULT_SMOKE_WORKDIR;
    this.workdir = env.VAULT_SMOKE_WORKDIR ? join(env.VAULT_SMOKE_WORKDIR, this.prefix) : mkdtempSync(join(tmpdir(), `${ this.prefix }-`));
    mkdirSync(this.workdir, { recursive: true });
    this.password = `synthetic-${ randomBytes(12).toString('base64url') }`;
    this.tokens = Object.fromEntries(['bootstrap', 'control', 'approval', 'broker', 'files'].map(key => [key, randomBytes(32).toString('base64url')]));
    this.started = [];
  }

  onPath(binary) {
    try { execFileSync('sh', ['-c', `command -v ${ binary }`], { stdio: 'ignore' }); return true; } catch { return false; }
  }

  log(message) { console.log(`vault-upgrade-smoke: ${ message }`); }

  makeTls() {
    const dir = join(this.workdir, 'tls');
    mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-keyout', join(dir, 'tls.key'), '-out', join(dir, 'tls.crt')], { stdio: 'ignore' });
    // Synthetic throwaway key; the container runs as uid 1000 and must read it through a read-only bind mount.
    chmodSync(dir, 0o755);
    chmodSync(join(dir, 'tls.key'), 0o644);
    chmodSync(join(dir, 'tls.crt'), 0o644);
    return dir;
  }

  vault(name, image) {
    const container = new DesktopVaultContainer(this.runtime, name, image, this.database, this.tlsDir, this.tokens);
    container.start();
    this.started.push(name);
    return container;
  }

  async run() {
    const t0 = Date.now();
    this.log(`runtime=${ this.runtime.name } OLD=${ this.oldImage } NEW=${ this.newImage }`);
    try {
      this.tlsDir = this.makeTls();
      for (const image of [POSTGRES_IMAGE, this.oldImage, this.newImage]) this.runtime.pull(image);
      this.database = new SyntheticPostgres(this.runtime, `${ this.prefix }-db`, this.workdir);
      this.started.push(this.database.name);
      await this.database.start();

      // OLD image: empty DB -> migrations -> first password creates the vault -> synthetic items.
      const oldVault = this.vault(`${ this.prefix }-old`, this.oldImage);
      const port = this.runtime.vaultHostPort();
      const oldClient = new DesktopHumanClient(port, this.tokens.control);
      await oldVault.waitHealthy(oldClient);
      const setup = await oldClient.openSession();
      assert.equal(setup.setupRequired, true, 'OLD image starts with no vault account on the empty DB');
      await oldClient.unlockOk(this.password);
      const fixtures = SyntheticItems.all();
      const saved = [];
      for (const item of fixtures) saved.push({ id: (await oldClient.saveItem(item)).id, item });
      const oldListed = await oldClient.listItems();
      assert.equal(oldListed.length, fixtures.length, 'OLD image lists every synthetic item it saved');

      const itemsBefore = this.database.itemRows();
      const keyBefore = this.database.keyRow();
      assert.equal(itemsBefore.length, fixtures.length, 'one items row per synthetic item');
      assert.equal(keyBefore.length, 1, 'exactly one users key row');
      this.log(`OLD: created vault + ${ itemsBefore.length } items via the human API; snapshot taken`);
      this.runtime.stop(oldVault.name);

      // NEW image on the same DB: migrations run at startup.
      const newVault = this.vault(`${ this.prefix }-new`, this.newImage);
      const newClient = new DesktopHumanClient(port, this.tokens.control);
      await newVault.waitHealthy(newClient);
      assert.deepEqual(this.database.itemRows(), itemsBefore, 'every items row is byte-identical after NEW starts and migrates');
      assert.deepEqual(this.database.keyRow(), keyBefore, 'users key row sha256, xmin and ctid are unchanged after NEW starts');
      this.log('NEW started + migrated: items rows and key row (sha256, xmin, ctid) unchanged');

      const session = await newClient.openSession();
      assert.equal(session.setupRequired, false, 'NEW image sees the existing vault (no setup prompt)');
      const wrong = await newClient.unlock(`${ this.password }-wrong`);
      assert.equal(wrong.status, 401, 'wrong password is refused with HTTP 401');
      await newClient.unlockOk(this.password);
      const listed = await newClient.listItems();
      assert.deepEqual(listed.map(item => item.id).sort(), saved.map(entry => entry.id).sort(), 'NEW lists exactly the same item ids');
      for (const { id, item } of saved) {
        const shown = listed.find(entry => entry.id === id);
        assert.equal(shown.name, item.name, 'decrypted item name matches');
        assert.equal(shown.type, item.type, 'decrypted item type matches');
        const revealed = await newClient.reveal(id);
        const secret = revealed.item;
        if (item.password) assert.equal(secret.password, item.password, 'revealed password matches what OLD saved');
        if (item.notes) assert.equal(secret.notes, item.notes, 'revealed note matches what OLD saved');
        if (item.card) assert.equal(secret.card?.number, item.card.number, 'revealed card number matches what OLD saved');
      }
      assert.deepEqual(this.database.itemRows(), itemsBefore, 'unlock/list/reveal on NEW does not rewrite item rows');
      assert.deepEqual(this.database.keyRow(), keyBefore, 'unlock on NEW does not rewrite the key row');
      this.log(`NEW: wrong password -> 401; right password unlocks; ${ listed.length }/${ saved.length } items listed, names/types/secrets match; rows still unchanged after unlock`);
      this.log(`PASS in ${ Math.round((Date.now() - t0) / 1000) }s`);
    } finally {
      if (process.env.VAULT_SMOKE_KEEP === '1') {
        this.log(`KEEP: left ${ this.started.join(', ') } and ${ this.workdir }`);
      } else {
        for (const name of [...this.started].reverse()) {
          try { this.runtime.remove(name); } catch { /* already gone */ }
        }
        if (existsSync(this.workdir)) rmSync(this.workdir, { recursive: true, force: true });
      }
    }
  }
}

try {
  await new VaultUpgradeSmoke().run();
} catch (error) {
  console.error(`vault-upgrade-smoke: FAILED (${ error.message })`);
  process.exitCode = 1;
}
