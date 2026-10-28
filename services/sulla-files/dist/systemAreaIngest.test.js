// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { isSystemArea, shouldSkipSearchIndex, skipSearchIndexForVersion } from './systemAreaIngest.js';
test('search indexing is skipped only on request and only for read-only system areas', () => {
    assert.equal(shouldSkipSearchIndex('1', 'logs'), true);
    assert.equal(shouldSkipSearchIndex('1', 'training-data'), true);
    // The Sulla area (docs, use cases) and customer collections stay searchable.
    assert.equal(shouldSkipSearchIndex('1', 'sulla'), false);
    assert.equal(shouldSkipSearchIndex('1', null), false);
    assert.equal(shouldSkipSearchIndex('1', undefined), false);
    // Absent or malformed requests never change behaviour.
    assert.equal(shouldSkipSearchIndex(undefined, 'logs'), false);
    assert.equal(shouldSkipSearchIndex('true', 'logs'), false);
    assert.equal(shouldSkipSearchIndex('0', 'training-data'), false);
});
test('only the three system collections accept plain system-area ingest', () => {
    for (const area of ['logs', 'training-data', 'sulla'])
        assert.equal(isSystemArea(area), true);
    for (const area of [null, undefined, '', 'Logs', 'user', 42])
        assert.equal(isSystemArea(area), false);
});
test('skipping drops the queued index job and marks only that current version unindexed', async () => {
    const calls = [];
    await skipSearchIndexForVersion({ query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } }, 'file-1', 'version-1');
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /^DELETE FROM file_index_jobs WHERE file_id=\$1 AND version_id=\$2$/);
    assert.deepEqual(calls[0].values, ['file-1', 'version-1']);
    assert.match(calls[1].sql, /^UPDATE files SET .*extraction_status='unsupported'/s);
    assert.match(calls[1].sql, /WHERE id=\$1 AND current_version_id=\$2$/);
    assert.deepEqual(calls[1].values, ['file-1', 'version-1']);
});
