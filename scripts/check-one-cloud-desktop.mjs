// SPDX-License-Identifier: GPL-2.0-or-later
// Manager-only focused check. Requires Node >=22.15; no npm packages or network.
// node scripts/check-one-cloud-desktop.mjs /absolute/path/to/Workers/src/config/model-catalog-data/snapshot.json
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

class DesktopAuthorityCheck {
  async load(relativePath, replacements = []) {
    let source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    for (const [before, after] of replacements) {
      assert.ok(source.includes(before), `Composition import changed: ${before}`);
      source = source.replace(before, after);
    }
    // Transform the actual repository classes, not a copied validator. Only the
    // database/host composition imports are stubbed; all catalog logic is real.
    const javascript = stripTypeScriptTypes(source, { mode: 'transform' });
    return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
  }

  async run(snapshotPath) {
    assert.ok(snapshotPath, 'Pass the actual Workers snapshot.json path');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    const { SharedModelCatalogClient } = await this.load('../pkg/sulla-desktop/agent/languagemodels/sharedModelCatalog.ts', [
      ["import { SullaSettingsModel } from '../database/models/SullaSettingsModel';", "const SullaSettingsModel = { get() { throw new Error('Unexpected DB access'); }, set() { throw new Error('Unexpected DB access'); } };"],
      ["import { SULLA_CLOUD_HOST } from '../../../../services/sulla-vault/src/sullaCloudRelay';", "const SULLA_CLOUD_HOST = 'catalog.invalid';"],
    ]);
    const { ModelCompatibilityService, ProviderClientStatus } = await this.load('../pkg/sulla-desktop/agent/languagemodels/ModelCompatibilityService.ts');
    let cache = null;
    const getCache = async() => cache;
    const setCache = async(_key, value) => { cache = value; };
    const live = new SharedModelCatalogClient(async(url, init) => {
      assert.equal(new URL(url).pathname, '/shared-model-catalog');
      assert.deepEqual(init.headers, { Accept: 'application/json' });
      return new Response(JSON.stringify(snapshot));
    }, () => 1_000_000, getCache, setCache);
    const codex = await live.listModels('codex');
    assert.ok(codex.length, 'Actual snapshot was rejected by Desktop validator');
    for (const id of ['gpt-6.2-sol', 'gpt-6.2-astra']) {
      const model = codex.find(row => row.id === id);
      assert.ok(model, `Missing exact released Codex identity: ${id}`);
      assert.equal(model.selectionMode, 'exact');
      assert.equal(model.defaultReasoningEffort, 'low');
      assert.equal(model.minimumClientVersion, '0.166.0');
      assert.deepEqual(model.supportedReasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
      assert.equal(model.revision, snapshot.revision);
      assert.equal(model.provenance.status, 'verified');
      assert.ok(model.source.revision && model.source.sha256);
      const selected = new ProviderClientStatus(async() => ({ codex: model.minimumClientVersion }), async() => '0.0.0', async() => ({ required: true, installed: true, version: '99.0.0' }));
      await new ModelCompatibilityService(provider => selected.get(provider)).assertClient('codex', model);
      const old = new ModelCompatibilityService(async() => ({ required: true, installed: true, version: '0.0.0' }));
      await assert.rejects(old.assertClient('codex', model), /requires client/);
      const unknown = new ModelCompatibilityService(async() => ({ required: true, installed: true }));
      await assert.rejects(unknown.assertClient('codex', model), /Cannot verify/);
      assert.equal(model.id, id, 'Compatibility must not mutate an explicit pin');
    }
    const offline = async() => { throw new Error('synthetic offline'); };
    const cached = new SharedModelCatalogClient(offline, () => 2_000_000, getCache, setCache);
    assert.deepEqual(await cached.listModels('codex'), codex);
    assert.equal(cached.getStatus().state, 'stale');
    const firstStart = new SharedModelCatalogClient(offline, () => 2_000_000, async() => null, async() => {});
    assert.deepEqual(await firstStart.listModels('codex'), []);
    assert.equal(firstStart.getStatus().state, 'unavailable');
    const invalid = new SharedModelCatalogClient(async() => new Response(JSON.stringify({ schemaVersion: 99, providers: [] })), () => 2_000_000, getCache, setCache);
    assert.deepEqual(await invalid.listModels('codex'), codex);
    await assert.rejects(invalid.refreshNow());
    assert.deepEqual(await cached.listModels('codex'), codex);
    console.log(JSON.stringify({ ok: true, revision: snapshot.revision, checks: ['actual Cloud schema', 'Codex6.2 exact metadata', 'selected worker client floor', 'old/unknown clients rejected', 'offline validated LKG', 'first-start unavailable', 'invalid schema cannot poison LKG'] }));
  }
}

await new DesktopAuthorityCheck().run(process.argv[2]);
