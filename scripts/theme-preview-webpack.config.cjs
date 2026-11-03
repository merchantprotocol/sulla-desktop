// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const path = require('node:path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { VueLoaderPlugin } = require('vue-loader');

const repoRoot = path.resolve(__dirname, '..');
const rendererRoot = path.join(repoRoot, 'pkg', 'sulla-desktop');
const previewRoot = path.join(rendererRoot, 'entry', 'theme-preview');

module.exports = {
  mode: 'development', target: 'web', context: rendererRoot,
  entry: path.join(rendererRoot, 'entry', 'theme-preview.ts'),
  output: { path: path.join(repoRoot, '.theme-preview-dev'), filename: 'theme-preview.js', clean: true },
  resolve: {
    extensions: ['.ts', '.js', '.vue'],
    alias: {
      '@pkg': rendererRoot,
      electron$: path.join(previewRoot, 'electron.ts'),
      '@pkg/utils/ipcRenderer$': path.join(previewRoot, 'ipcRenderer.ts'),
      '@pkg/agent/database/models/SullaSettingsModel$': path.join(previewRoot, 'SullaSettingsModel.ts'),
    },
    fallback: { fs: false, path: false, os: false, crypto: false, stream: false, util: false, child_process: false, net: false, tls: false },
  },
  module: { rules: [
    { test: /\.vue$/, loader: require.resolve('vue-loader') },
    { test: /\.ts$/, loader: require.resolve('ts-loader'), options: { transpileOnly: true, appendTsSuffixTo: ['\\.vue$'] } },
    { test: /\.css$/, use: [require.resolve('vue-style-loader'), require.resolve('css-loader')] },
    { test: /\.s[ac]ss$/, use: [require.resolve('vue-style-loader'), require.resolve('css-loader'), { loader: require.resolve('sass-loader'), options: { additionalData: '@use "sass:math"; @import "@pkg/assets/styles/base/_variables.scss"; @import "@pkg/assets/styles/base/_functions.scss"; @import "@pkg/assets/styles/base/_mixins.scss";' } }] },
    { test: /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|svg)$/i, type: 'asset/resource' },
  ] },
  plugins: [
    new VueLoaderPlugin(),
    new webpack.DefinePlugin({ 'process.client': 'true', 'process.env.NODE_ENV': JSON.stringify('development'), 'process.env.SULLA_TEST': JSON.stringify('theme-preview'), __VUE_OPTIONS_API__: true, __VUE_PROD_DEVTOOLS__: false, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false }),
    new HtmlWebpackPlugin({ template: path.join(rendererRoot, 'theme-preview.html') }),
  ],
  devServer: { host: '0.0.0.0', port: 4174, hot: false, historyApiFallback: true, client: { logging: 'warn' } },
  devtool: 'eval-cheap-module-source-map',
};
