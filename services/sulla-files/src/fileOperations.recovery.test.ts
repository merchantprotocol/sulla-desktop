import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LocalFilesManager } from './localManager.js';

test('startup recovery rolls back uncommitted publication and preserves committed publication', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-operation-recovery-'));
  const operationRoot = join(root, '.sulla-trash', '.operations');
  const bytes = Buffer.from('synthetic operation payload');
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const moveStage = join(operationRoot, 'move-op', 'move-file.move');
  const moveTarget = join(root, 'moved.txt');
  const copyStage = join(operationRoot, 'copy-op', 'copy-file.copy');
  const copyTarget = join(root, 'copied.txt');
  const recordedTarget = join(root, 'recorded.txt');
  const unrelatedTarget = join(root, 'unrelated.txt');
  await mkdir(join(operationRoot, 'move-op'), { recursive: true });
  await mkdir(join(operationRoot, 'copy-op'), { recursive: true });
  await writeFile(moveStage, bytes);
  await link(moveStage, moveTarget);
  await writeFile(copyStage, bytes);
  await link(copyStage, copyTarget);
  await mkdir(join(operationRoot, 'recorded-op'), { recursive: true });
  await writeFile(recordedTarget, bytes);
  await writeFile(unrelatedTarget, bytes);
  const copyFingerprint = await stat(copyTarget, { bigint: true });
  const recordedFingerprint = await stat(recordedTarget, { bigint: true });

  const rows = [
    {
      operation_id: 'planned-op',
      state:        'planned',
      plan:         [{ fileId: 'planned-file', sourcePath: 'never-created.txt', targetPath: 'unrelated.txt', stagePath: '.sulla-trash/.operations/planned-op/planned-file.copy', contentHash, kind: 'copy' }],
      receipts:     [],
    },
    {
      operation_id: 'move-op',
      state:        'publishing',
      plan:         [{ fileId: 'move-file', sourcePath: 'source.txt', targetPath: 'moved.txt', stagePath: '.sulla-trash/.operations/move-op/move-file.move', contentHash, kind: 'move' }],
      receipts:     [],
    },
    {
      operation_id: 'recorded-op',
      state:        'publishing',
      plan:         [{ fileId: 'recorded-file', sourcePath: 'original.txt', targetPath: 'recorded.txt', stagePath: '.sulla-trash/.operations/recorded-op/recorded-file.copy', contentHash, kind: 'copy' }],
      receipts:     [{
        fileId:      'recorded-file',
        stagePath:   '.sulla-trash/.operations/recorded-op/recorded-file.copy',
        targetPath:  'recorded.txt',
        published:   true,
        fingerprint: { dev: recordedFingerprint.dev.toString(), ino: recordedFingerprint.ino.toString(), size: Number(recordedFingerprint.size), mtimeMs: Number(recordedFingerprint.mtimeMs) },
      }],
    },
    {
      operation_id: 'copy-op',
      state:        'db-committed',
      plan:         [{ fileId: 'copy-file', sourcePath: 'original.txt', targetPath: 'copied.txt', stagePath: '.sulla-trash/.operations/copy-op/copy-file.copy', contentHash, kind: 'copy' }],
      receipts:     [{
        fileId:      'copy-file',
        stagePath:   '.sulla-trash/.operations/copy-op/copy-file.copy',
        targetPath:  'copied.txt',
        published:   true,
        fingerprint: { dev: copyFingerprint.dev.toString(), ino: copyFingerprint.ino.toString(), size: Number(copyFingerprint.size), mtimeMs: Number(copyFingerprint.mtimeMs) },
      }],
    },
  ];
  const completed:string[] = [];
  const db = {
    query: (sql:string, values?:unknown[]) => {
      if (sql.includes("state IN('planned','publishing','db-committed')")) return Promise.resolve({ rows, rowCount: rows.length });
      if (sql.includes("SET state='completed'")) completed.push(String(values?.[0]));
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  };
  const manager = new LocalFilesManager(db as any, { filesRoot: root, dataRoot: join(root, '..', 'private'), chunkRoot: join(root, '..', 'chunks'), paused: true } as any);

  try {
    await manager.recoverPathOperations();
    assert.deepEqual(completed, ['planned-op', 'move-op', 'recorded-op', 'copy-op']);
    assert.equal(await manager.mutations.exists('.sulla-trash/.operations/never-created/file.copy'), false);
    assert.deepEqual(await readFile(unrelatedTarget), bytes);
    assert.deepEqual(await readFile(join(root, 'source.txt')), bytes);
    await assert.rejects(readFile(moveTarget), { code: 'ENOENT' });
    await assert.rejects(readFile(recordedTarget), { code: 'ENOENT' });
    assert.deepEqual(await readFile(copyTarget), bytes);
    await assert.rejects(readFile(moveStage), { code: 'ENOENT' });
    await assert.rejects(readFile(copyStage), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
