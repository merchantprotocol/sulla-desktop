// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { parseDurableFileReferences } from './filesReferences';

describe('parseDurableFileReferences', () => {
  it('matches the cross-device durable URI fixture', () => {
    expect(parseDurableFileReferences('Here\nsulla-file://file_123?version=v_9&name=Roadmap%20Q4.md&path=Projects%2FRoadmap%20Q4.md')).toEqual([
      { fileId: 'file_123', versionId: 'v_9', name: 'Roadmap Q4.md', path: 'Projects/Roadmap Q4.md' },
    ]);
  });
});
