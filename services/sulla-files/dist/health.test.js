import assert from 'node:assert/strict';
import test from 'node:test';
import { healthPayload } from './health.js';
// Exact compatibility gate from pkg/rancher-desktop/main/sullaFilesWatcher.ts ensureUnlocked().
const desktopRejects = (health) => !health.legacyImport || !['clear', 'secure-import-required'].includes(health.legacyImport.state);
const cfg = (legacyPreflight) => ({ mode: 'desktop', legacyPreflight });
test('healthz reports legacyImport clear when no preflight has run, surviving JSON', () => {
    const body = JSON.parse(JSON.stringify(healthPayload(cfg(), false)));
    assert.equal(body.legacyImport.state, 'clear');
    assert.equal(desktopRejects(body), false);
});
test('healthz passes a real preflight result through unchanged', () => {
    const pre = { state: 'secure-import-required', protectedPrefix: '.sulla', code: 'FILES_LEGACY_SECURE_IMPORT_REQUIRED', action: 'import' };
    const body = JSON.parse(JSON.stringify(healthPayload(cfg(pre), true)));
    assert.deepEqual(body.legacyImport, pre);
    assert.equal(desktopRejects(body), false);
});
test('healthz locked reflects readiness and shape is preserved', () => {
    assert.equal(healthPayload(cfg(), true).locked, false);
    const locked = healthPayload(cfg(), false, { state: 'locked', legacyImport: 'clear' });
    assert.equal(locked.locked, true);
    assert.deepEqual(Object.keys(locked).sort(), ['legacyImport', 'lifecycle', 'locked', 'mode', 'ok']);
});
