const webpack = require('webpack');
const WebpackDevServer = require('webpack-dev-server');
const config = require('./files-preview-webpack.config.cjs');

const compiler = webpack(config);
const server = new WebpackDevServer(config.devServer, compiler);

server.start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
