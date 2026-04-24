import path from 'node:path';

import _ from 'lodash';
import webpack from 'webpack';

const rootDir = path.resolve(import.meta.dirname, '..', '..');

/**
 * Exclude Monaco worker entries from a splitChunks cache group while
 * preserving its original `chunks` semantics ("initial", "async", "all", or function).
 *
 * WARNING: Do NOT replace group.chunks with a bare function like:
 *   group.chunks = (chunk) => !chunk.name?.endsWith('.worker');
 * That silently drops the original "initial"/"async"/"all" constraint and BREAKS
 * CSS extraction for non-editor pages (vendor/package CSS disappears).
 */
function excludeWorkers(originalChunks) {
  return (chunk) => {
    if (chunk.name?.endsWith('.worker')) {
      return false;
    }
    if (originalChunks === 'initial') {
      return chunk.canBeInitial();
    }
    if (originalChunks === 'async') {
      return !chunk.canBeInitial();
    }
    if (typeof originalChunks === 'function') {
      return originalChunks(chunk);
    }
    // 'all' or undefined — include everything (except workers, filtered above)
    return true;
  };
}

export default {
  publicPath:          '/',
  outputDir:           path.resolve(rootDir, 'dist', 'app'),
  productionSourceMap: false,

  /** @type { (config: import('webpack-chain')) => void } */
  chainWebpack: (config) => {
    config.target('electron-renderer');
    config.resolve.alias.set('@pkg', path.resolve(rootDir, 'pkg', 'rancher-desktop'));
    config.resolve.extensions.add('.ts');

    config.module.rule('ts')
      .test(/\.ts$/)
      .use('ts-loader')
      .loader('ts-loader')
      .options({
        transpileOnly:    process.env.NODE_ENV === 'development',
        appendTsSuffixTo: ['\\.vue$'],
        happyPackMode:    true,
      });

    config.module.rule('yaml')
      .test(/\.ya?ml(?:\?[a-z0-9=&.]+)?$/)
      .use('js-yaml-loader')
      .loader('js-yaml-loader')
      .options({ name: '[path][name].[ext]' });

    config.module.rule('raw')
      .test(/(?:^|[/\\])assets[/\\]scripts[/\\]/)
      .use('raw-loader')
      .loader('raw-loader');

    // Load .md files from agent/prompts as raw text
    config.module.rule('prompts')
      .test(/(?:^|[/\\])agent[/\\]prompts[/\\].*\.md$/)
      .use('raw-loader')
      .loader('raw-loader');

    config.plugin('define-plugin').use(webpack.DefinePlugin, [{
      'process.client':       JSON.stringify(true),
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
      'process.env.RD_TEST':  JSON.stringify(process.env.RD_TEST || ''),

      'process.env.FEATURE_DIAGNOSTICS_FIXES': process.env.RD_ENV_DIAGNOSTICS_FIXES === '1',

      __VUE_OPTIONS_API__:                     true,
      __VUE_PROD_DEVTOOLS__:                   false,
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    }]);

    config.module.rule('vue').use('vue-loader').tap((options) => {
      _.set(options, 'loaders.ts', 'ts-loader');

      return options;
    });

    // Monaco editor worker bundles
    const workerEntries = {
      'editor.worker': 'monaco-editor/esm/vs/editor/editor.worker.js',
      'json.worker':   'monaco-editor/esm/vs/language/json/json.worker.js',
      'css.worker':    'monaco-editor/esm/vs/language/css/css.worker.js',
      'html.worker':   'monaco-editor/esm/vs/language/html/html.worker.js',
      'ts.worker':     'monaco-editor/esm/vs/language/typescript/ts.worker.js',
    };
    for (const [name, entry] of Object.entries(workerEntries)) {
      config.entry(name).add(entry);
    }
  },

  configureWebpack: (config) => {
    config.externals = {
      'puppeteer-extra-plugin': 'commonjs puppeteer-extra-plugin',
      'puppeteer-extra':        'commonjs puppeteer-extra',
      puppeteer:                'commonjs puppeteer',
      'clone-deep':             'commonjs clone-deep',
      '@composio/core':         'commonjs @composio/core',
      '@composio/client':       'commonjs @composio/client',
      '@reflink/reflink':       'commonjs @reflink/reflink',
    };

    // Workers run in a web-worker context where `global` is not defined.
    // `self` is the universal global for both browser and web-worker scopes.
    config.output.globalObject = 'self';

    // Worker bundles need stable filenames (no hash) so getWorkerUrl can reference them
    const origFilename = config.output.filename;
    config.output.filename = (pathData) => {
      if (pathData.chunk?.name?.endsWith('.worker')) {
        return `${ pathData.chunk.name }.bundle.js`;
      }
      return typeof origFilename === 'function' ? origFilename(pathData) : origFilename;
    };

    // Workers are standalone scripts — they cannot load shared chunks.
    // See excludeWorkers() for why we must preserve the original chunks value.
    const splitChunks = config.optimization.splitChunks;
    if (splitChunks && typeof splitChunks === 'object') {
      for (const group of Object.values(splitChunks.cacheGroups || {})) {
        if (typeof group === 'object') {
          group.chunks = excludeWorkers(group.chunks);
        }
      }
    }
  },

  css: {
    loaderOptions: {
      sass: {
        additionalData: `
          @use 'sass:math';
          @import "@pkg/assets/styles/base/_variables.scss";
          @import "@pkg/assets/styles/base/_functions.scss";
          @import "@pkg/assets/styles/base/_mixins.scss";
        `,
      },
    },
  },

  pluginOptions: {
    i18n: {
      locale:         'en',
      fallbackLocale: 'en',
      localeDir:      'locales',
      enableInSFC:    false,
    },
  },

  transpileDependencies: ['yaml'],

  pages: {
    index: {
      entry:    path.join(import.meta.dirname, 'entry', 'index.ts'),
      template: path.join(import.meta.dirname, 'public', 'index.html'),
    },
    agent: {
      entry:    path.join(import.meta.dirname, 'entry', 'agent.ts'),
      template: path.join(import.meta.dirname, 'public', 'agent.html'),
      filename: 'agent.html',
    },
    'lm-settings': {
      entry:    path.join(import.meta.dirname, 'entry', 'lm-settings.ts'),
      template: path.join(import.meta.dirname, 'public', 'lm-settings.html'),
      filename: 'lm-settings.html',
    },
    'audio-settings': {
      entry:    path.join(import.meta.dirname, 'entry', 'audio-settings.ts'),
      template: path.join(import.meta.dirname, 'public', 'audio-settings.html'),
      filename: 'audio-settings.html',
    },
    'computer-use-settings': {
      entry:    path.join(import.meta.dirname, 'entry', 'computer-use-settings.ts'),
      template: path.join(import.meta.dirname, 'public', 'computer-use-settings.html'),
      filename: 'computer-use-settings.html',
    },
    updates: {
      entry:    path.join(import.meta.dirname, 'entry', 'updates.ts'),
      template: path.join(import.meta.dirname, 'public', 'updates.html'),
      filename: 'updates.html',
    },
    'first-run': {
      entry:    path.join(import.meta.dirname, 'entry', 'first-run.ts'),
      template: path.join(import.meta.dirname, 'public', 'first-run.html'),
      filename: 'first-run.html',
    },
    'side-panel': {
      entry:    path.join(import.meta.dirname, 'entry', 'side-panel.ts'),
      template: path.join(import.meta.dirname, 'public', 'side-panel.html'),
      filename: 'side-panel.html',
    },
    'capture-studio': {
      entry:    path.join(import.meta.dirname, 'entry', 'capture-studio.ts'),
      template: path.join(import.meta.dirname, 'public', 'capture-studio.html'),
      filename: 'capture-studio.html',
    },
  },
};
