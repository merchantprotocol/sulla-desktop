import { describe, expect, test } from '@jest/globals';

import { resolveSullaServiceImage, shouldRefreshSullaServiceImage } from '../sullaServiceImages';

describe(resolveSullaServiceImage, () => {
  test('uses the source build in a development checkout', () => {
    expect(resolveSullaServiceImage('sulla-vault', '/source', '1.6.1', undefined, () => true)).toEqual({
      build: { context: '/source', dockerfile: 'services/sulla-vault/Dockerfile' },
      image: 'sulla-vault:local',
    });
  });

  test('every managed service tracks latest regardless of app version', () => {
    const names = ['sulla-accounts', 'sulla-agent', 'sulla-files', 'sulla-files-fuse', 'sulla-postgres', 'sulla-projects', 'sulla-relay', 'sulla-tools', 'sulla-vault', 'sulla-workflows'] as const;

    for (const name of names) {
      for (const version of ['1.6.1', '1.6.1-dev.a893f36', '?']) {
        expect(resolveSullaServiceImage(name, '/packaged', version, undefined, () => false, undefined).image)
          .toBe(`ghcr.io/merchantprotocol/${ name }:latest`);
      }
    }
  });

  test('SULLA_SERVICE_IMAGE_TAG pins every service; blank is ignored', () => {
    expect(resolveSullaServiceImage('sulla-vault', '/packaged', '1.6.1', undefined, () => false, '1.6.0').image)
      .toBe('ghcr.io/merchantprotocol/sulla-vault:1.6.0');
    expect(resolveSullaServiceImage('sulla-files', '/packaged', '1.6.1', undefined, () => false, 'sha-abc1234').image)
      .toBe('ghcr.io/merchantprotocol/sulla-files:sha-abc1234');
    expect(resolveSullaServiceImage('sulla-vault', '/packaged', '1.6.1', undefined, () => false, '  ').image)
      .toBe('ghcr.io/merchantprotocol/sulla-vault:latest');
  });

  test('per-service override and source build win over the pinned tag', () => {
    expect(resolveSullaServiceImage('sulla-vault', '/packaged', '1.6.1', 'registry.example/vault:x', () => false, '1.6.0').image)
      .toBe('registry.example/vault:x');
    expect(resolveSullaServiceImage('sulla-vault', '/source', '1.6.1', undefined, () => true, '1.6.0').build).toBeDefined();
  });

  test('refreshes only Desktop-managed published images', () => {
    const published = resolveSullaServiceImage('sulla-tools', '/packaged', '1.6.1', undefined, () => false, undefined);
    const overridden = resolveSullaServiceImage('sulla-tools', '/packaged', '1.6.1', 'registry.example/tools:stable', () => false);
    const source = resolveSullaServiceImage('sulla-tools', '/source', '1.6.1', undefined, () => true);

    expect(shouldRefreshSullaServiceImage(published)).toBe(true);
    expect(shouldRefreshSullaServiceImage(overridden, 'registry.example/tools:stable')).toBe(false);
    expect(shouldRefreshSullaServiceImage(source)).toBe(false);
  });
});
