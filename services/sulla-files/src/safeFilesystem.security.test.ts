import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FilesMutationCoordinator, type PinnedRegularFile } from './safeFilesystem.js';

async function contents(pinned:PinnedRegularFile):Promise<string> {
  const chunks:Buffer[] = [];
  for await (const chunk of pinned.createReadStream(7)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('descriptor-pinned mutations preserve replacements and reread copies from byte zero', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-safe-'));
  try {
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs/source.txt'), 'original-content');
    const coordinator = new FilesMutationCoordinator(root);

    let reads = 0;
    const copied = await coordinator.copyVerified({
      source: 'docs/source.txt',
      target: 'docs/copy.txt',
      verify: async pinned => {
        reads += 1;
        assert.equal(await contents(pinned), 'original-content');
      },
    });
    assert.ok(reads >= 3, 'source and publication checks all reread from offset zero');
    assert.equal(await readFile(join(root, 'docs/copy.txt'), 'utf8'), 'original-content');
    await coordinator.finalizePublication(copied);

    let raced = false;
    await assert.rejects(
      coordinator.evictVerified({
        source:     'docs/source.txt',
        quarantine: '.sulla-trash/.residency/race.evicting',
        verify:     async pinned => {
          assert.equal(await contents(pinned), raced ? 'replacement-content' : 'original-content');
          if (!raced) {
            raced = true;
            await rename(join(root, 'docs/source.txt'), join(root, 'docs/original-moved.txt'));
            await writeFile(join(root, 'docs/source.txt'), 'replacement-content');
          }
        },
      }),
      /identity changed/,
    );
    assert.equal(await readFile(join(root, 'docs/source.txt'), 'utf8'), 'replacement-content');
    assert.equal(await readFile(join(root, 'docs/original-moved.txt'), 'utf8'), 'original-content');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('eviction recovery is no-clobber and publication rollback preserves conflicts', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-recovery-'));
  try {
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs/source.txt'), 'safe');
    const coordinator = new FilesMutationCoordinator(root);
    const verify = async(pinned:PinnedRegularFile) => assert.equal(await contents(pinned), 'safe');
    const eviction = await coordinator.evictVerified({
      source:     'docs/source.txt',
      quarantine: '.sulla-trash/.residency/source.evicting',
      verify,
    });
    await writeFile(join(root, 'docs/source.txt'), 'new-edit');
    await assert.rejects(coordinator.recoverEviction(eviction, verify), /replaced/);
    assert.equal(await readFile(join(root, 'docs/source.txt'), 'utf8'), 'new-edit');
    assert.equal(await readFile(join(root, '.sulla-trash/.residency/source.evicting'), 'utf8'), 'safe');

    await writeFile(join(root, '.sulla-trash/.residency/publish.stage'), 'safe');
    const publication = await coordinator.publishVerified({
      staged: '.sulla-trash/.residency/publish.stage',
      target: 'docs/published.txt',
      verify,
    });
    await rename(join(root, 'docs/published.txt'), join(root, 'docs/published-moved.txt'));
    await writeFile(join(root, 'docs/published.txt'), 'new-edit');
    await assert.rejects(coordinator.rollbackPublication(publication, verify), /changed/);
    assert.equal(await readFile(join(root, 'docs/published.txt'), 'utf8'), 'new-edit');
    assert.equal(await readFile(join(root, '.sulla-trash/.residency/publish.stage'), 'utf8'), 'safe');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
