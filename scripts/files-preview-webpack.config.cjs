// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { VueLoaderPlugin } = require('vue-loader');

const repoRoot = path.resolve(__dirname, '..');
const rendererRoot = path.join(repoRoot, 'pkg', 'sulla-desktop');

module.exports = {
  mode: 'development',
  target: 'web',
  context: rendererRoot,
  entry: path.join(rendererRoot, 'entry', 'files-preview.ts'),
  output: { path: path.join(repoRoot, '.files-preview-dev'), filename: 'files-preview.js', clean: true },
  resolve: { extensions: ['.ts', '.js', '.vue'], alias: { '@pkg': rendererRoot } },
  module: {
    rules: [
      { test: /\.vue$/, loader: require.resolve('vue-loader') },
      { test: /\.ts$/, loader: require.resolve('ts-loader'), options: { transpileOnly: true } },
      { test: /\.css$/, use: [require.resolve('vue-style-loader'), require.resolve('css-loader')] },
    ],
  },
  plugins: [new VueLoaderPlugin(), new HtmlWebpackPlugin({ template: path.join(rendererRoot, 'files-preview.html') })],
  devServer: { host: '0.0.0.0', port: 4173, hot: false, client: { logging: 'warn' } },
  devtool: 'eval-cheap-module-source-map',
};
