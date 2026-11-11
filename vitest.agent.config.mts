// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the agent-runtime test suite (OOP rebuild plan §4/§11).
// Tests live under pkg/sulla-desktop/agent/tests/** and run in GitHub CI
// (.github/workflows/agent-tests.yml) against a real Postgres service.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileScript, parse } from '@vue/compiler-sfc';
import { transformWithEsbuild, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

// Compiles .vue SFCs for agent specs that mount components (e.g. Unit/Studio/StudioLivePage.spec.ts).
// Dropped by #2090 by accident; without it `yarn test:agent` fails to load any .vue import.
class VueSfcTestPlugin implements Plugin {
  readonly name = 'sulla-vue-sfc-tests';
  readonly enforce = 'pre' as const;

  async transform(source: string, id: string) {
    if (!id.endsWith('.vue')) return null;
    const { descriptor, errors } = parse(source, { filename: id });

    if (errors.length) throw errors[0];
    const compiled = compileScript(descriptor, {
      id:       `data-v-${ Buffer.from(id).toString('hex').slice(-8) }`,
      inlineTemplate: true,
    });

    return transformWithEsbuild(compiled.content, id, { loader: compiled.lang === 'ts' ? 'ts' : 'js' });
  }
}

export default defineConfig({
  plugins: [new VueSfcTestPlugin()],
  resolve: {
    alias: [
      { find: /^@pkg\/(.*)$/, replacement: path.join(root, 'pkg/sulla-desktop/$1') },
      { find: '@sulla/vault-crypto', replacement: path.join(root, 'packages/vault-crypto/src/index.ts') },
    ],
  },
  test: {
    include:         ['pkg/sulla-desktop/agent/tests/**/*.spec.ts', 'pkg/sulla-desktop/composables/MarketplaceSearchService.spec.ts', 'pkg/sulla-desktop/composables/MarketplaceListingRepository.spec.ts', 'pkg/sulla-desktop/composables/MarketplaceListingPresenter.spec.ts', 'pkg/sulla-desktop/composables/MarketplaceSearchController.spec.ts', 'pkg/sulla-desktop/main/marketplace/MarketplaceBrowseRowMapper.spec.ts', 'pkg/sulla-desktop/main/UseCaseSuggestionQuery.spec.ts'],
    environment:     'node',
    testTimeout:     20_000,
    hookTimeout:     60_000,
    globalSetup:     ['pkg/sulla-desktop/agent/tests/Support/GlobalTestDatabase.ts'],
    setupFiles:      ['pkg/sulla-desktop/agent/tests/Support/UnexpectedNetworkGuard.ts'],
    // Specs that share the real database run in one worker, one file at a time.
    fileParallelism: false,
    pool:            'threads',
    maxWorkers:      2,
    passWithNoTests: true,
  },
});
