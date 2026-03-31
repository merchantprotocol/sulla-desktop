/**
 * WebSocketClientService — Type exports and process-aware factory.
 *
 * The external WebSocket hub has been replaced by an in-process IPC message bus.
 * This module preserves the type exports used across the codebase and provides
 * the factory function that returns the correct bus for the current process.
 */

export interface WebSocketMessage {
  type:        string;
  data:        unknown;
  id:          string;
  originalId?: string;
  timestamp:   number;
  channel?:    string;
}

export type WebSocketMessageHandler = (message: WebSocketMessage) => void;
export type ConnectHandler = () => void;

/**
 * Process-aware factory — returns IpcMessageBus (main) or IpcMessageBusRenderer (renderer).
 * All consumers import this function and get the IPC bus transparently.
 */
export function getWebSocketClientService(): import('./IpcMessageBus').IpcMessageBus | import('./IpcMessageBusRenderer').IpcMessageBusRenderer {
  const isMain = typeof process !== 'undefined' && (process as any).type === 'browser';
  if (isMain) {
    const { IpcMessageBus } = require('./IpcMessageBus');
    return IpcMessageBus.getInstance();
  } else {
    const { IpcMessageBusRenderer } = require('./IpcMessageBusRenderer');
    return IpcMessageBusRenderer.getInstance();
  }
}
