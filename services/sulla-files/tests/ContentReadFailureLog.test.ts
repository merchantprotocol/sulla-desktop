// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { ContentReadFailureLog } from '../src/ContentReadFailureLog.js';

describe('ContentReadFailureLog', () => {
  const capture = () => { const lines:string[] = []; return { lines, log: new ContentReadFailureLog(line => lines.push(line)) } };
  const parse = (line:string) => JSON.parse(line.slice(line.indexOf('{')));

  // risk: data accuracy. A share read failure is labelled with its share id, never misreported as a file id.
  it('records a share content failure under its share id with no file or version id', () => {
    const { lines, log } = capture();
    log.report(Object.assign(new Error('read failed'), { code: 'ENOENT' }), { route: 'share-content', shareId: 'share-123' });
    expect(parse(lines[0])).toMatchObject({ cause: 'chunk_blob_missing', route: 'share-content', shareId: 'share-123', fileId: null, versionId: null });
  });

  // risk: data accuracy. File reads keep their file/version ids and gain no share field.
  it('records a file content failure with its file and version ids and no share id', () => {
    const { lines, log } = capture();
    log.report(new Error('boom'), { route: 'download', fileId: 'file-1', versionId: 'version-1' });
    const entry = parse(lines[0]);
    expect(entry).toMatchObject({ route: 'download', fileId: 'file-1', versionId: 'version-1' });
    expect(entry).not.toHaveProperty('shareId');
  });
});
