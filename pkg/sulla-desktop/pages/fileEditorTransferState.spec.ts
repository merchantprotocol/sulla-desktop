// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { FileEditorTransferState } from './fileEditorTransferState';

describe('FileEditorTransferState', () => {
  it('restores unsaved text and dirty state only for the matching file path', () => {
    // risk: data loss — a transferred dirty editor must not reload over unsaved text
    expect(FileEditorTransferState.restore('/work/notes.md', { filePath: '/work/notes.md', text: 'unsaved draft', dirty: true }))
      .toEqual({ filePath: '/work/notes.md', text: 'unsaved draft', dirty: true });
    expect(FileEditorTransferState.restore('/work/other.md', { filePath: '/work/notes.md', text: 'unsaved draft', dirty: true })).toBeNull();
  });
});
