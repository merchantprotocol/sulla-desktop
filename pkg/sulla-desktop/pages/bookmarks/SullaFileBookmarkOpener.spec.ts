// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data accuracy — a Files bookmark must open the document it names, at its latest version, never the web.
import { describe, expect, it, vi } from 'vitest';

import { SullaFileBookmarkOpener, type SullaFileOpenPorts } from './SullaFileBookmarkOpener';

function ports(editorPaths: RegExp = /\.(html|md)$/i): SullaFileOpenPorts & { openDocument: ReturnType<typeof vi.fn>; openWithFilesHandler: ReturnType<typeof vi.fn> } {
  return {
    canOpenInEditor:      path => editorPaths.test(path),
    openDocument:         vi.fn(),
    openWithFilesHandler: vi.fn(async() => undefined),
  };
}

describe('SullaFileBookmarkOpener', () => {
  it('opens the Files document by fileId and path, with no version pinned', async() => {
    const fake = ports();
    const opener = new SullaFileBookmarkOpener(fake);

    const opened = await opener.open({ kind: 'bookmark', url: 'sulla-file://file_1?version=old-v&path=Mentors%2Fmain.html&name=main.html' });

    expect(opened).toBe(true);
    expect(fake.openDocument).toHaveBeenCalledWith({ fileId: 'file_1', path: 'Mentors/main.html' });
    expect(fake.openDocument.mock.calls[0][0]).not.toHaveProperty('version');
    expect(fake.openWithFilesHandler).not.toHaveBeenCalled();
  });

  it('falls back to the Files open handler by fileId for types the editor cannot show', async() => {
    const fake = ports();
    const opener = new SullaFileBookmarkOpener(fake);

    await opener.open({ kind: 'bookmark', url: 'sulla-file://file_2?path=Docs%2Fdeck.pptx&name=deck.pptx' });

    expect(fake.openDocument).not.toHaveBeenCalled();
    expect(fake.openWithFilesHandler).toHaveBeenCalledWith('file_2');
  });

  it('ignores folders, malformed links and other schemes so the caller can fall back', async() => {
    const fake = ports();
    const opener = new SullaFileBookmarkOpener(fake);

    expect(await opener.open({ kind: 'folder', url: 'sulla-file://file_3?path=x.md' })).toBe(false);
    expect(await opener.open({ kind: 'bookmark', url: 'sulla-file://bad.id?path=x.md' })).toBe(false);
    expect(await opener.open({ kind: 'bookmark', url: 'https://example.com' })).toBe(false);
    expect(fake.openDocument).not.toHaveBeenCalled();
    expect(fake.openWithFilesHandler).not.toHaveBeenCalled();
  });
});
