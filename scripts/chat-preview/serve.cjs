// SPDX-License-Identifier: GPL-2.0-or-later

const path = require('node:path');

const HtmlWebpackPlugin = require('html-webpack-plugin');
const { VueLoaderPlugin } = require('vue-loader');
const webpack = require('webpack');
const WebpackDevServer = require('webpack-dev-server');

const root = path.resolve(__dirname, '../..');
const renderer = path.join(root, 'pkg/sulla-desktop');
const entry = path.join(renderer, 'entry/chat-preview');
const port = Number(process.env.CHAT_PREVIEW_PORT || 8888);
const host = process.env.CHAT_PREVIEW_HOST || '127.0.0.1';
const allowedHosts = process.env.CHAT_PREVIEW_ALLOWED_HOST ? [process.env.CHAT_PREVIEW_ALLOWED_HOST] : 'auto';

const compiler = webpack({
  context: renderer,
  mode: 'development',
  target: 'web',
  devtool: false,
  entry: path.join(entry, 'index.ts'),
  output: { path: path.join(__dirname, '.dev'), filename: 'chat-preview.js', publicPath: '/' },
  resolve: {
    modules: [path.join(__dirname, 'node_modules'), 'node_modules'],
    extensions: ['.ts', '.js', '.vue'],
    extensionAlias: { '.js': ['.ts', '.js'] },
    alias: {
      'electron$': path.join(entry, 'electron.ts'),
      '@pkg/agent/database/models/SullaSettingsModel$': path.join(entry, 'SullaSettingsModel.ts'),
      '../../agent/ChatInterface$': path.join(entry, 'ChatInterface.ts'),
      '@pkg/agent/services/WebSocketClientService$': path.join(entry, 'WebSocketClientService.ts'),
      '@pkg': renderer,
    },
  },
  module: { rules: [
    { test: /\.vue$/, loader: require.resolve('vue-loader') },
    { test: /\.ts$/, loader: require.resolve('ts-loader'), options: { transpileOnly: true, appendTsSuffixTo: ['\\.vue$'] } },
    { test: /\.css$/, use: [require.resolve('vue-style-loader'), require.resolve('css-loader')] },
    { test: /\.s[ac]ss$/, use: [require.resolve('vue-style-loader'), require.resolve('css-loader'), {
      loader: require.resolve('sass-loader'),
      options: {
        sassOptions: { silenceDeprecations: ['import', 'global-builtin', 'if-function'] },
        additionalData: '@use "sass:math"; @import "@pkg/assets/styles/base/_variables.scss"; @import "@pkg/assets/styles/base/_functions.scss"; @import "@pkg/assets/styles/base/_mixins.scss";',
      },
    }] },
    { test: /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico)$/i, type: 'asset/resource' },
  ] },
  plugins: [
    new VueLoaderPlugin(),
    new HtmlWebpackPlugin({ filename: 'chat-preview.html', template: path.join(renderer, 'chat-preview.html') }),
    new webpack.DefinePlugin({
      'process.client': 'true',
      'process.env.SULLA_TEST': JSON.stringify('chat-preview'),
      __VUE_OPTIONS_API__: true,
      __VUE_PROD_DEVTOOLS__: false,
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    }),
  ],
  stats: { preset: 'errors-warnings', moduleTrace: true },
});

const server = new WebpackDevServer({
  port, host, allowedHosts, static: false, hot: false, liveReload: false, client: false,
  headers: { 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'" },
}, compiler);

server.start().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
