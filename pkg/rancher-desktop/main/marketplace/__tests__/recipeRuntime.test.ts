/**
 * @jest-environment node
 */
import yaml from 'yaml';

import { rewriteRecipeCompose } from '../recipeRuntime';

describe('recipe runtime persistence', () => {
  it('replaces a relative data bind with a stable named volume', () => {
    const result = rewriteRecipeCompose('customer-portal', `
services:
  app:
    image: example/app:1
    volumes:
      - ./data:/var/lib/app
`, { 'data/seed.json': '{}' });
    const compose = yaml.parse(result.compose);

    expect(compose.services.app.volumes).toEqual(['app-app:/var/lib/app']);
    expect(compose.volumes['app-app']).toEqual({ name: 'sulla-customer-portal-app-app' });
    expect(result.volumeSeeds).toEqual([{
      volumeName: 'sulla-customer-portal-app-app',
      sourcePath: 'data',
    }]);
  });
});
