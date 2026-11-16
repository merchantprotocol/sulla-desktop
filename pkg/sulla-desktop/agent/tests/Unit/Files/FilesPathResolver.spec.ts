// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { FilesPathResolver } from '../../../../../../services/sulla-files/src/filesPathResolver';

describe('FilesPathResolver', () => {
  const resolver = new FilesPathResolver();

  it('maps a mounted top-level folder path into the default collection', () => {
    // risk: data accuracy — mounted paths must not be mistaken for collection IDs/names.
    const candidates = resolver.candidates([
      { id: 'home', name: 'Home', is_default: true },
      { id: 'archive', name: 'Archive' },
    ], 'Projects/kinstead-hackathon-game/map-builder.html');

    expect(candidates[0]).toEqual({ collectionId: 'home', path: 'Projects/kinstead-hackathon-game/map-builder.html' });
  });

  it('keeps explicit collection-rooted paths ahead of mounted-path fallbacks', () => {
    // risk: data accuracy — identical folder names across collections must prefer explicit roots.
    const candidates = resolver.candidates([
      { id: 'home', name: 'Home', is_default: true },
      { id: 'projects', name: 'Projects' },
    ], 'Projects/map-builder.html');

    expect(candidates[0]).toEqual({ collectionId: 'projects', path: 'map-builder.html' });
    expect(candidates[1]).toEqual({ collectionId: 'home', path: 'Projects/map-builder.html' });
  });
});
