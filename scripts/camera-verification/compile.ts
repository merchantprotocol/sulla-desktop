// SPDX-License-Identifier: GPL-2.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';

import webpack from 'webpack';

import buildUtils from '../lib/build-utils';

const require = createRequire(import.meta.url);

class CaptureVerificationCompiler {
  private readonly root = path.resolve('artifacts/ce1');

  /** Vue CLI ships its own nested webpack; its plugins must run on that same copy (as vue-cli-service does). */
  private readonly vueWebpack: typeof webpack = createRequire(require.resolve('@vue/cli-service/package.json'))('webpack');

  async compile(name: string, config: webpack.Configuration, engine: typeof webpack = webpack): Promise<void> {
    config.output = { ...config.output, path: path.join(this.root, name) };
    await new Promise<void>((resolve, reject) => {
      const compiler = engine(config);
      compiler.run((error, stats) => {
        if (stats) {
          fs.writeFileSync(path.join(this.root, name + '-stats.json'), JSON.stringify(stats.toJson({ all: false, hash: true, assets: true, modules: true, nestedModules: true, errors: true, warnings: true }), null, 2));
        }
        compiler.close(closeError => {
          if (error || closeError || !stats || stats.hasErrors()) { if (stats) console.error(this.rootCauses(stats.compilation)); reject(error || closeError || new Error(stats?.toString({ all: false, errors: true }))); }
          else {
            try { this.inventory(name, stats); resolve(); } catch (error) { reject(error); }
          }
        });
      });
    });
  }

  /** Original exceptions (with stacks) behind webpack's wrapped ModuleNotFound/child-compilation errors. */
  private rootCauses(compilation: any, depth = 0): string {
    const lines: string[] = [];
    for (const e of compilation.errors || []) {
      lines.push('ROOT-CAUSE ' + String(e.message).split('\n')[0]);
      if (e.error?.stack) lines.push('ROOT-CAUSE-STACK ' + String(e.error.stack).split('\n').slice(0, 8).join(' | '));
    }
    if (depth < 4) for (const child of compilation.children || []) lines.push(this.rootCauses(child, depth + 1));
    return lines.filter(Boolean).join('\n');
  }

  private inventory(name: string, stats: webpack.Stats): void {
    const externals: { name: string; resolved: string }[] = [];
    const visit = (modules: any[]) => {
      for (const module of modules || []) {
        if (module.name?.startsWith('external ')) {
          const match = module.name.match(/"([^"\n]+)"$/);
          if (match) {
            const request = match[1];
            const builtin = request === 'electron' || builtinModules.includes(request.replace(/^node:/, ''));
            externals.push({ name: request, resolved: builtin ? '<runtime builtin>' : require.resolve(request) });
          }
        }
        visit(module.modules);
      }
    };
    visit(stats.toJson({ all: false, modules: true, nestedModules: true }).modules as any[]);
    fs.writeFileSync(path.join(this.root, name + '-externals.json'), JSON.stringify(externals, null, 2));
  }

  async run(): Promise<void> {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(path.join(this.root, 'compile-identity.json'), JSON.stringify({ sourceSha: process.env.CE1_EXPECTED_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, productionEntry: 'pkg/sulla-desktop/entry/capture-studio.ts', runtimeEntry: 'scripts/camera-verification/entry.ts', mainConfig: 'scripts/lib/build-utils.ts webpackConfig', preloadConfig: 'scripts/lib/build-utils.ts webpackPreloadConfig', fixturesAppliedToProduction: false }, null, 2));
    process.env.NODE_ENV = 'production';
    process.env.VUE_CLI_SERVICE_CONFIG_PATH = path.resolve('pkg/sulla-desktop/vue.config.mjs');
    const Service = require('@vue/cli-service/lib/Service');
    const service = new Service(process.cwd());
    // Same plugin selection as the production renderer build (scripts/build.ts: --skip-plugins eslint).
    service.setPluginsToSkip({ 'skip-plugins': 'eslint' }, ['build', '--skip-plugins', 'eslint']);
    await service.init('production');
    // Narrow pages, NOT dependencies or loaders. The original entry and its entire graph compile.
    service.projectOptions.pages = { 'capture-studio': service.projectOptions.pages['capture-studio'] };
    const production = service.resolveWebpackConfig(service.resolveChainableWebpackConfig());
    production.entry = { 'capture-studio': production.entry['capture-studio'] };
    await this.compile('production-renderer', production, this.vueWebpack);
    buildUtils.isDevelopment = false;
    await this.compile('production-main', buildUtils.webpackConfig);
    await this.compile('production-preload', buildUtils.webpackPreloadConfig);

    const runtime = service.resolveWebpackConfig(service.resolveChainableWebpackConfig());
    runtime.entry = { 'capture-studio': path.resolve('scripts/camera-verification/entry.ts') };
    runtime.resolve.alias['@pkg/utils/paths$'] = path.resolve('scripts/camera-verification/paths.ts');
    runtime.plugins.push(new this.vueWebpack.DefinePlugin({ __CE1_DIRECTORY__: JSON.stringify(path.resolve('artifacts/ce1/runtime-home')), __CE1_RESOURCES__: JSON.stringify(path.resolve('resources')) }));
    await this.compile('runtime', runtime, this.vueWebpack);
    const runtimeStats = fs.readFileSync(path.join(this.root, 'runtime-stats.json'), 'utf8');
    if (/ProductionCaptureWindow|sulla-desktop[\\/]sulla\.ts|bootstrapEntry/.test(runtimeStats)) throw new Error('Personal startup leaked into runtime graph');
    if (!runtimeStats.includes('pages/CaptureStudio.vue')) throw new Error('Actual parent missing from runtime graph');
  }
}
new CaptureVerificationCompiler().run().catch(error => { console.error(error); console.error('::error title=CE1 compile::' + String(error.stack || error).replace(/%/g, '%25').replace(/\n/g, '%0A').replace(/\r/g, '%0D')); process.exitCode = 1; });
