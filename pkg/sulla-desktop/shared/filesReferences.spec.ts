// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { DurableFileReferenceParser, parseDurableFileReferences } from './filesReferences';

describe('parseDurableFileReferences', () => {
  it('reads the Desktop sulla-file card with version, name and path', () => {
    // risk: data accuracy — the card must point at the exact file version.
    const [reference] = parseDurableFileReferences('See sulla-file://a-1?version=v-2&name=roadmap.md&path=Plans%2Froadmap.md');
    expect(reference).toEqual({ fileId: 'a-1', versionId: 'v-2', path: 'Plans/roadmap.md', name: 'roadmap.md' });
  });
  it('renders the https /f/<id> private link on the default origin', () => {
    // risk: data accuracy — a mobile link in chat must still open the file in Desktop.
    const references = parseDurableFileReferences('Open https://sulladesktop.com/f/a-7 now');
    expect(references.map(item => item.fileId)).toEqual(['a-7']);
  });
  it('ignores https links on hosts that are not configured Files origins', () => {
    // risk: privacy — arbitrary web links must not become file cards.
    expect(parseDurableFileReferences('https://evil.example/f/a-7')).toEqual([]);
  });
  it('accepts a configured staging origin when the caller supplies it', () => {
    const parser = new DurableFileReferenceParser(['https://sulladesktop.com', 'https://staging.sulladesktop.com']);
    expect(parser.parse('https://staging.sulladesktop.com/f/a-8').map(item => item.fileId)).toEqual(['a-8']);
  });
  it('keeps separate entries for different versions of the same file', () => {
    expect(parseDurableFileReferences('sulla-file://a-1?version=v1 and https://sulladesktop.com/f/a-1')).toHaveLength(2);
  });
});
