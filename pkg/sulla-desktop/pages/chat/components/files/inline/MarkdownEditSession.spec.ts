// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { MarkdownEditSession } from './MarkdownEditSession';

describe('MarkdownEditSession', () => {
  it('requires authorized complete Markdown and an explicit original version token before editing', () => { // risk: unauthorized or partial writes can overwrite inaccessible source data
    expect(new MarkdownEditSession({ content: '# private', versionToken: 'v1', authorized: false, complete: true }).beginEdit()).toBe(false);
    expect(new MarkdownEditSession({ content: '# partial', versionToken: 'v1', authorized: true, complete: false }).beginEdit()).toBe(false);
    expect(new MarkdownEditSession({ content: '# no token', authorized: true, complete: true }).beginEdit()).toBe(false);
  });

  it('emits the original version token and preserves the draft on conflict and external change', () => { // risk: stale saves must not discard edits or overwrite a newer Files version
    const session = new MarkdownEditSession({ content: '# original', versionToken: 'version-1', authorized: true, complete: true });
    expect(session.beginEdit()).toBe(true);
    session.setDraft('# Jonathon\'s draft');

    const request = session.requestSave();
    expect(request).toMatchObject({ content: '# Jonathon\'s draft', baseVersionId: 'version-1' });
    expect(request).not.toBeNull();
    session.resolveSave({ requestId: request!.requestId, status: 'conflict', currentVersionToken: 'version-2' });

    expect(session.snapshot()).toMatchObject({ editing: true, draft: '# Jonathon\'s draft', externalChange: true, canSave: false, saveStatus: 'conflict' });
    session.discardDraft();
    expect(session.snapshot().editing).toBe(false);
  });

  it('keeps a failed save retryable with the same base token and the original draft', () => { // risk: a transient failure must not silently lose user edits
    const session = new MarkdownEditSession({ content: '# original', versionToken: 'version-3', authorized: true, complete: true });
    session.beginEdit();
    session.setDraft('# keep this draft');
    const request = session.requestSave();
    expect(request).not.toBeNull();

    session.resolveSave({ requestId: request!.requestId, status: 'error', message: 'offline' });
    expect(session.snapshot()).toMatchObject({ draft: '# keep this draft', editing: true, canSave: true, saveStatus: 'error' });
    expect(session.requestSave()).toMatchObject({ content: '# keep this draft', baseVersionId: 'version-3' });
  });

  it('keeps a draft when the same file changes outside the editor', () => { // risk: refreshes must not replace unsaved user-authored content
    const session = new MarkdownEditSession({ content: '# original', versionToken: 'v4', authorized: true, complete: true });
    session.beginEdit();
    session.setDraft('# local draft');
    session.updateSource({ content: '# external update', versionToken: 'v5', authorized: true, complete: true });

    expect(session.snapshot()).toMatchObject({ draft: '# local draft', externalChange: true, canSave: false });
  });
});
