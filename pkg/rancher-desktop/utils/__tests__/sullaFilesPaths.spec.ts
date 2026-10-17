/** @jest-environment node */
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { resolveSullaFilesUserRoot } from '../sullaFilesPaths';

describe('Files user-root compatibility', () => {
  const home = path.join(path.sep, 'synthetic-home');
  const lower = path.join(home, 'sulla', 'files');
  const upper = path.join(home, 'sulla', 'Files');

  it('uses the lowercase spelling when both names are the same case-insensitive directory', () => {
    const result = resolveSullaFilesUserRoot(home, value => [lower, upper].includes(value) ? { dev: 1, ino: 2 } : undefined);
    expect(result).toEqual({ canonicalPath: lower, activePath: lower, compatibility: 'case-alias' });
  });

  it('keeps an existing uppercase directory active on a case-sensitive filesystem without renaming it', () => {
    const result = resolveSullaFilesUserRoot(home, value => value === upper ? { dev: 1, ino: 3 } : undefined);
    expect(result).toEqual({ canonicalPath: lower, activePath: upper, compatibility: 'existing-uppercase' });
  });

  it('uses lowercase for a fresh install', () => {
    expect(resolveSullaFilesUserRoot(home, () => undefined)).toEqual({ canonicalPath: lower, activePath: lower, compatibility: 'canonical' });
  });
});
