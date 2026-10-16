import { describe, expect, test } from '@jest/globals';

import { resolveSullaServiceImage } from '../sullaServiceImages';

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

  test('falls back to latest only without a release or commit tag', () => {
    expect(resolveSullaServiceImage('sulla-workflows', '/packaged', '?', undefined, () => false).image)
      .toBe('ghcr.io/merchantprotocol/sulla-workflows:latest');
  });
});
