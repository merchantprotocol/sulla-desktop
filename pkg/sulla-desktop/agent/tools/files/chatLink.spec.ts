import { describe, expect, it } from 'vitest';
import { fileChatLink, MobileFileLink } from './chatLink';

describe('Files chat links', () => {
  it('keeps the Desktop card link with version, name and path', () => {
    // risk: data accuracy — the card must open the right file and version in the Desktop editor.
    expect(fileChatLink({ fileId: 'a-123', path: 'Plans/roadmap.md', name: 'roadmap.md', versionId: 'v-9' }))
      .toBe('sulla-file://a-123?version=v-9&name=roadmap.md&path=Plans%2Froadmap.md');
  });
  it('refuses folders and incomplete descriptors for the card link', () => {
    expect(fileChatLink({ fileId: 'folder', path: 'Plans', kind: 'folder' })).toBeUndefined();
    expect(fileChatLink({ fileId: 'a-123' })).toBeUndefined();
  });
});

describe('private mobile file links', () => {
  it('builds an https /f/<id> link on the supplied origin with no file metadata', () => {
    // risk: privacy — the URL carries only the id; the recipient must sign in and resolve the file through owner/org-scoped APIs.
    const url = new MobileFileLink('https://sulladesktop.com').url({ fileId: 'a-123', path: 'Plans/roadmap.md', name: 'roadmap.md' });
    expect(url).toBe('https://sulladesktop.com/f/a-123');
    expect(url).not.toContain('roadmap');
  });
  it('defaults to sulladesktop.com', () => {
    expect(new MobileFileLink().url({ fileId: 'a-123', path: 'x.md' })).toBe('https://sulladesktop.com/f/a-123');
  });
  it('refuses folders and descriptors without a path', () => {
    // risk: privacy — folders are never shared through the file route.
    expect(new MobileFileLink().url({ fileId: 'folder', path: 'Plans', kind: 'folder' })).toBeUndefined();
    expect(new MobileFileLink().url({ fileId: 'a-123' })).toBeUndefined();
  });
});
