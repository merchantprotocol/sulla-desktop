/** @jest-environment jsdom */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from '@jest/globals';

import { openDocumentTab } from '../useBrowserTabs';

describe('openDocumentTab', () => {
  it('reuses the tab for an already-open Files document', () => {
    const first = openDocumentTab({ fileId: 'file-open-reuse', path: 'Projects/example/notes.md' }, false);
    const second = openDocumentTab({ fileId: 'file-open-reuse', path: 'Projects/example/renamed.md' }, false);

    expect(second.id).toBe(first.id);
    expect(second.documentFile?.path).toBe('Projects/example/renamed.md');
  });
});
