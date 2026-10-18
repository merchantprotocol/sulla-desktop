import { describe, expect, test } from '@jest/globals';

import { resolveSullaServiceImage, shouldRefreshSullaServiceImage } from '../sullaServiceImages';

describe(resolveSullaServiceImage, () => {
  test('uses the source build in a development checkout', () => {
    expect(resolveSullaServiceImage('sulla-vault', '/source', '1.6.1', undefined, () => true)).toEqual({
      build: { context: '/source', dockerfile: 'services/sulla-vault/Dockerfile' },
      image: 'sulla-vault:local',
    });
  });

  test('pins packaged releases and development builds to published tags', () => {
    expect(resolveSullaServiceImage('sulla-vault', '/packaged', '1.6.1', undefined, () => false).image)
      .toBe('ghcr.io/merchantprotocol/sulla-vault:1.6.1');
    expect(resolveSullaServiceImage('sulla-workflows', '/packaged', '1.6.1-dev.a893f36', undefined, () => false).image)
      .toBe('ghcr.io/merchantprotocol/sulla-workflows:sha-a893f36');
  });

  test('uses latest for packaged Files while preserving source builds and overrides', () => {
    expect(resolveSullaServiceImage('sulla-files', '/packaged', '1.6.1', undefined, () => false).image)
      .toBe('ghcr.io/merchantprotocol/sulla-files:latest');
    expect(resolveSullaServiceImage('sulla-files', '/packaged', '1.6.1', 'registry.example/files:stable', () => false).image)
      .toBe('registry.example/files:stable');
    expect(resolveSullaServiceImage('sulla-files', '/source', '1.6.1', undefined, () => true)).toEqual({
      build: { context: '/source', dockerfile: 'services/sulla-files/Dockerfile' },
      image: 'sulla-files:local',
    });
  });

  test('falls back to latest only without a release or commit tag', () => {
    expect(resolveSullaServiceImage('sulla-workflows', '/packaged', '?', undefined, () => false).image)
      .toBe('ghcr.io/merchantprotocol/sulla-workflows:latest');
  });

  test('refreshes only Desktop-managed published images', () => {
    const published = resolveSullaServiceImage('sulla-tools', '/packaged', '1.6.1', undefined, () => false);
    const overridden = resolveSullaServiceImage('sulla-tools', '/packaged', '1.6.1', 'registry.example/tools:stable', () => false);
    const source = resolveSullaServiceImage('sulla-tools', '/source', '1.6.1', undefined, () => true);

    expect(shouldRefreshSullaServiceImage(published)).toBe(true);
    expect(shouldRefreshSullaServiceImage(overridden, 'registry.example/tools:stable')).toBe(false);
    expect(shouldRefreshSullaServiceImage(source)).toBe(false);
  });
});
