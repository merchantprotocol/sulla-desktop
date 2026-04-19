/**
 * Model — mic audio socket client.
 *
 * Connects to the main process Unix domain socket for streaming
 * mic audio directly, bypassing Electron IPC serialization.
 *
 * Protocol (per message):
 *   4 bytes (UInt32BE) — payload length
 *   N bytes            — WebM/Opus audio data
 */

const net = require('net');
const log = window.audioDriver.log;

let socket = null;
let socketPath = null;
let connected = false;
let reconnectTimer = null;

/**
 * Connect to the mic audio socket.
 *
 * @param {string} path — Unix domain socket path from main process
 */
function connect(path) {
  if (socket) disconnect();

  socketPath = path;
  _connect();
}

function _connect() {
  if (!socketPath) return;

  socket = net.createConnection(socketPath);

  socket.on('connect', () => {
    connected = true;
    log.info('MicSocket', 'Connected', { path: socketPath });
  });

  socket.on('close', () => {
    connected = false;
    socket = null;
    // Reconnect if we still have a path (intentional disconnect clears it)
    if (socketPath) {
      reconnectTimer = setTimeout(_connect, 1000);
    }
  });

  socket.on('error', (err) => {
    log.warn('MicSocket', 'Connection error', { error: err.message });
  });
}

/**
 * Send a mic audio chunk over the socket.
 *
 * @param {ArrayBuffer} buffer — WebM/Opus audio chunk from MediaRecorder
 */
let sendCount = 0;

function send(buffer) {
  if (!socket || !connected) {
    log.debug('MicSocket', 'Send skipped — not connected', { hasSocket: !!socket, connected });
    return;
  }

  const data = Buffer.from(buffer);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);

  socket.write(header);
  socket.write(data);

  sendCount++;
  if (sendCount <= 3 || sendCount % 100 === 0) {
    log.debug('MicSocket', 'Chunk sent', { bytes: data.length, total: sendCount });
  }
}

/**
 * Disconnect from the socket.
 */
function disconnect() {
  socketPath = null;
  connected = false;
  sendCount = 0;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (socket) {
    socket.destroy();
    socket = null;
  }

  log.info('MicSocket', 'Disconnected');
}

function isConnected() {
  return connected;
}

module.exports = { connect, disconnect, send, isConnected };
