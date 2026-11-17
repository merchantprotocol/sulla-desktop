import { describe, expect, it } from 'vitest';
import { fileChatLink } from './chatLink';

describe('private Files chat links', () => {
  it('creates an HTTPS file route without embedding file metadata or public capabilities', () => {
    // risk: privacy — the recipient must authenticate and resolve the file through owner/org-scoped Cloud APIs.
    expect(fileChatLink({ fileId: 'a-123', path: 'Plans/roadmap.md', name: 'roadmap.md' }))
      .toBe('https://sulladesktop.com/f/a-123');
  });
  it('refuses folders and incomplete descriptors', () => {
    expect(fileChatLink({ fileId: 'folder', path: 'Plans', kind: 'folder' })).toBeUndefined();
    expect(fileChatLink({ fileId: 'a-123' })).toBeUndefined();
  });
});
