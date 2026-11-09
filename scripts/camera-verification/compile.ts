// SPDX-License-Identifier: GPL-2.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import webpack from 'webpack';

import buildUtils from '../lib/build-utils';

const require = createRequire(import.meta.url);

class CaptureVerificationCompiler {
  private readonly root = path.resolve('artifacts/ce1');

  async compile(name: string, config: webpack.Configuration): Promise<void> {
    config.output = { ...config.output, path: path.join(this.root, name) };
    await new Promise<void>((resolve, reject) => {
      const compiler = webpack(config);
      compiler.run((error, stats) => {
        if (stats) {
          fs.writeFileSync(path.join(this.root, name + '-stats.json'), JSON.stringify(stats.toJson({ all: false, hash: true, assets: true, modules: true, nestedModules: true, errors: true, warnings: true }), null, 2));
        }
        compiler.close(closeError => {
          if (error || closeError || !stats || stats.hasErrors()) reject(error || closeError || new Error(stats?.toString({ all: false, errors: true })));
          else resolve();
        });
      });
    });
  }

  async run(): Promise<void> {
    fs.mkdirSync(this.root, { recursive: true });
    process.env.NODE_ENV = 'production';
    process.env.VUE_CLI_SERVICE_CONFIG_PATH = path.resolve('pkg/sulla-desktop/vue.config.mjs');
    const Service = require('@vue/cli-service/lib/Service');
    const service = new Service(process.cwd());
    service.init('production');
    // Narrow pages, NOT dependencies or loaders. The original entry and its entire graph compile.
    service.projectOptions.pages = { 'capture-studio': service.projectOptions.pages['capture-studio'] };
    const production = service.resolveWebpackConfig(service.resolveChainableWebpackConfig());
    production.entry = { 'capture-studio': production.entry['capture-studio'] };
    await this.compile('production-renderer', production);
    buildUtils.isDevelopment = false;
    await this.compile('production-main', buildUtils.webpackConfig);
    await this.compile('production-preload', buildUtils.webpackPreloadConfig);

    const runtime = service.resolveWebpackConfig(service.resolveChainableWebpackConfig());
    runtime.entry = { 'capture-studio': path.resolve('scripts/camera-verification/entry.ts') };
    runtime.resolve.alias['@pkg/utils/paths$'] = path.resolve('scripts/camera-verification/paths.ts');
    runtime.plugins.push(new webpack.DefinePlugin({ __CE1_DIRECTORY__: JSON.stringify(path.resolve('artifacts/ce1/runtime-home')), __CE1_RESOURCES__: JSON.stringify(path.resolve('resources')) }));
    await this.compile('runtime', runtime);
    const runtimeStats = fs.readFileSync(path.join(this.root, 'runtime-stats.json'), 'utf8');
    if (/ProductionCaptureWindow|sulla-desktop[\\/]sulla\.ts|bootstrapEntry/.test(runtimeStats)) throw new Error('Personal startup leaked into runtime graph');
    if (!runtimeStats.includes('pages/CaptureStudio.vue')) throw new Error('Actual parent missing from runtime graph');
  }
}
new CaptureVerificationCompiler().run().catch(error => { console.error(error); process.exitCode = 1; });
