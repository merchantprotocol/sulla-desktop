import { describe, expect, it } from 'vitest';

import { SullaFilesPathsService } from './sullaFilesPaths.ts';

describe('Files paths service', () => {
it('selects the existing uppercase compatibility root without renaming it', () => {
  // risk: user data — root selection must never silently move or rename existing Files content.
  const service = new SullaFilesPathsService((value) => value.endsWith('/Files') ? { dev: 1, ino: 2 } : undefined);
  expect(service.resolveUserRoot('/Users/test')).toEqual({
    canonicalPath: '/Users/test/sulla/files', activePath: '/Users/test/sulla/Files', compatibility: 'existing-uppercase',
  });
});

it('rejects two different populated roots as ambiguous', () => {
  // risk: user data — do not choose one of two distinct stores and hide the other.
  const service = new SullaFilesPathsService((value) => value.endsWith('/Files') ? { dev: 1, ino: 2 } : { dev: 1, ino: 3 });
  expect(() => service.resolveUserRoot('/Users/test')).toThrow(/ambiguous/);
});
});
