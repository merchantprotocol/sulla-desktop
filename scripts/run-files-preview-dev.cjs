// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const webpack = require('webpack');
const WebpackDevServer = require('webpack-dev-server');
const config = require('./files-preview-webpack.config.cjs');

const compiler = webpack(config);
const server = new WebpackDevServer(config.devServer, compiler);

server.start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
