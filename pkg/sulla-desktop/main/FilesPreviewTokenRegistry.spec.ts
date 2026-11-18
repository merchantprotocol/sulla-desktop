// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { FilesPreviewTokenRegistry } from './FilesPreviewTokenRegistry';

describe('FilesPreviewTokenRegistry', () => {
  // risk: file access control — expired, unknown and revoked capabilities never authorize reads.
  it('expires, slides valid access, and revokes tokens', () => {
    let now = 0;
    const registry = new FilesPreviewTokenRegistry(() => now, 100);
    const token = registry.issue('collection', 'site', 'index.html');
    now = 90;
    expect(registry.resolve(token)?.collectionId).toBe('collection');
    now = 180;
    expect(registry.resolve(token)).toBeDefined();
    now = 281;
    expect(registry.resolve(token)).toBeUndefined();
    expect(registry.resolve('unknown')).toBeUndefined();
    const revoked = registry.issue('collection', '', 'index.html');
    registry.revoke(revoked);
    expect(registry.resolve(revoked)).toBeUndefined();
  });
});
