// SPDX-License-Identifier: GPL-2.0-or-later
// Run: node --test scripts/architecture-guard/FrozenFileGuard.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { FrozenFileGuard } from './FrozenFileGuard.mjs';

const SR = 'services/sulla-vault/src/browserEnvelope/syncRunner.ts';
const FROZEN_SRC = [
  "import { x } from './x.js';",
  'export type SyncOp = "a" | "b";',
  'export interface CloudSyncAuthority { run(): void }',
  'export { CloudSyncError };',
  'export class CloudVaultSyncRunner {',
  '  run() { return 1; }',
  '}',
  '',
].join('\n');
const entry = (over = {}) => ({
  reason: 'legacy runner, bug fixes only',
  maxLines: 7,
  exports: ['CloudSyncAuthority', 'CloudSyncError', 'CloudVaultSyncRunner', 'SyncOp'],
  exceptions: [],
  ...over,
});

/** In-memory repo: file path -> source. Comments/strings are not stripped (the fixtures have none). */
class MemorySource {
  constructor(files) { this.files = new Map(Object.entries(files)); }
  exists(file) { return this.files.has(file); }
  read(file) { return this.files.get(file); }
  code(src) { return src; }
}
const guardFor = files => new FrozenFileGuard(new MemorySource(files));

test('a frozen file within its line budget and export list passes', () => {
  // risk: false alarm — the guard must not block bug fixes that keep the file inside its budget.
  const result = guardFor({ [SR]: FROZEN_SRC }).check({ [SR]: entry() });
  assert.deepEqual(result.errors, []);
});

test('a frozen file that grows past its line budget fails', () => {
  // risk: architecture — new behaviour must not keep piling into the legacy runner.
  const grown = FROZEN_SRC.replace('  run() { return 1; }\n', '  run() { return 1; }\n  more() { return 2; }\n');
  const result = guardFor({ [SR]: grown }).check({ [SR]: entry() });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /\[frozen\] 8 lines, budget 7/);
});

test('a frozen file that gains an export fails, in every export form', () => {
  // risk: architecture — later stories must not start depending on new SR surface.
  for (const added of [
    'export class HeadChainLinkPolicy {}',
    'export const MAX = 3;',
    'export async function syncNow() {}',
    'export { helper as publicHelper };',
    "export * from './more.js';",
    'export default 5;',
  ]) {
    const src = FROZEN_SRC.replace("import { x } from './x.js';", added);
    const result = guardFor({ [SR]: src }).check({ [SR]: entry() });
    assert.equal(result.errors.length, 1, added);
    assert.match(result.errors[0], /new export\(s\)/, added);
  }
});

test('removing an export or lines is allowed (only a warning to tighten the budget)', () => {
  // risk: false alarm — shrinking the frozen file is the goal, never a failure.
  const src = FROZEN_SRC.replace('export { CloudSyncError };\n', '');
  const result = guardFor({ [SR]: src }).check({ [SR]: entry() });
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 2);
});

test('raising the budget against the PR base needs a new, complete exception entry', () => {
  // risk: architecture — the budget may only be raised through the documented exception path.
  const grown = FROZEN_SRC.replace('}\n', '  more() { return 2; }\n}\n');
  const base = { [SR]: entry() };

  const silentRaise = guardFor({ [SR]: grown }).check({ [SR]: entry({ maxLines: 8 }) }, base);
  assert.equal(silentRaise.errors.length, 1);
  assert.match(silentRaise.errors[0], /maxLines 7 -> 8.*without a new exceptions entry/);

  const newExport = guardFor({ [SR]: FROZEN_SRC }).check({ [SR]: entry({ exports: [...entry().exports, 'Extra'] }) }, base);
  assert.match(newExport.errors[0], /exports \+ Extra/);

  const incomplete = guardFor({ [SR]: grown }).check({ [SR]: entry({ maxLines: 8, exceptions: [{ date: '2026-11-12', reason: 'fix' }] }) }, base);
  assert.ok(incomplete.errors.some(e => /exceptions\[0\]\.approvedBy is required/.test(e)));

  const approved = guardFor({ [SR]: grown }).check({
    [SR]: entry({ maxLines: 8, exceptions: [{ date: '2026-11-12', reason: 'head-gap bug fix needs one guard clause', approvedBy: 'vault epic owner', pr: '#1' }] }),
  }, base);
  assert.deepEqual(approved.errors, []);
});

test('a PR may not unfreeze a file that still exists, and must drop the entry when the file is deleted', () => {
  // risk: architecture — the freeze ends only when the replacement lands and SR is deleted.
  const unfrozen = guardFor({ [SR]: FROZEN_SRC }).check({}, { [SR]: entry() });
  assert.match(unfrozen.errors[0], /unfreezes a file that still exists/);

  const deletedWithEntry = guardFor({}).check({ [SR]: entry() }, { [SR]: entry() });
  assert.match(deletedWithEntry.errors[0], /file is gone/);

  const deletedAndDropped = guardFor({}).check({}, { [SR]: entry() });
  assert.deepEqual(deletedAndDropped.errors, []);
});

test('the real repo: the sync runner is frozen and the guard passes on this tree', () => {
  // risk: architecture — the freeze is actually configured for SR and enforced by the CI guard.
  const config = JSON.parse(readFileSync('architecture-guard.config.json', 'utf8'));
  assert.ok(config.frozen?.[SR], 'syncRunner.ts must be listed under "frozen"');
  assert.ok(!config.frozen[SR].exports.includes('HeadChainLinkPolicy'), 'the head-chain policy lives in @sulla/domain now');
  execFileSync(process.execPath, ['scripts/architecture-guard/guard.mjs'], { stdio: 'pipe', env: { ...process.env, GUARD_BASE_REF: '' } });
});
