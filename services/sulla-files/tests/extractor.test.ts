import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { extractIndexText, MAX_DOCUMENT_BYTES } from '../src/extractor.js';

const temporaryDirectories:string[] = [];
afterEach(async() => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('extractIndexText', () => {
  it('rejects files above the indexing byte budget before invoking an extractor', async() => {
    // risk: native-memory — prevents oversized user files from expanding into extractor Buffers/WASM.
    const directory = await mkdtemp(join(tmpdir(), 'files-index-cap-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'large.txt');
    const file = await open(path, 'w');
    await file.truncate(MAX_DOCUMENT_BYTES + 1);
    await file.close();

    const result = await extractIndexText(path, 'text/plain');
    expect(result.status).toBe('unsupported');
    expect(result.text).toBeNull();
    expect(result.reasonCode).toBe('document_too_large');
  });
});
