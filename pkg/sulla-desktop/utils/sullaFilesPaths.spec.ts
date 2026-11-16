import assert from 'node:assert/strict';
import test from 'node:test';

import { SullaFilesPathsService } from './sullaFilesPaths.ts';

test('Files paths service selects the existing uppercase compatibility root without renaming it', () => {
  // risk: user data — root selection must never silently move or rename existing Files content.
  const service = new SullaFilesPathsService((value) => value.endsWith('/Files') ? { dev: 1, ino: 2 } : undefined);
  assert.deepEqual(service.resolveUserRoot('/Users/test'), {
    canonicalPath: '/Users/test/sulla/files', activePath: '/Users/test/sulla/Files', compatibility: 'existing-uppercase',
  });
});

test('Files paths service rejects two different populated roots as ambiguous', () => {
  // risk: user data — do not choose one of two distinct stores and hide the other.
  const service = new SullaFilesPathsService((value) => value.endsWith('/Files') ? { dev: 1, ino: 2 } : { dev: 1, ino: 3 });
  assert.throws(() => service.resolveUserRoot('/Users/test'), /ambiguous/);
});
