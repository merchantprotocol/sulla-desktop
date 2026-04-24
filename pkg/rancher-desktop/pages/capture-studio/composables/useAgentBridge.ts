/**
 * useAgentBridge — renderer-side endpoint for the CaptureStudio RPC bus.
 *
 * On mount, the composable:
 *   1. Dispatches `capture-studio:rpc-register` so the main-side bus
 *      knows this WebContents is the active CaptureStudio.
 *   2. Listens on `capture-studio:rpc` and routes commands to the
 *      handlers supplied by CaptureStudio.vue.
 *   3. Replies to main on `capture-studio:rpc-reply` with the handler
 *      result (or error).
 *
 * On unmount it unregisters + tears down the listener.
 *
 * All handlers are async by convention. Throwing inside a handler is
 * fine — the bridge catches and reports `{ ok: false, error }` back.
 */

import { onBeforeUnmount, onMounted } from 'vue';

const { ipcRenderer } = require('electron') as typeof import('electron');

const RPC_REQUEST    = 'capture-studio:rpc';
const RPC_REPLY      = 'capture-studio:rpc-reply';
const RPC_REGISTER   = 'capture-studio:rpc-register';
const RPC_UNREGISTER = 'capture-studio:rpc-unregister';

export type AgentBridgeHandler = (
  params: Record<string, unknown>,
) => Promise<unknown> | unknown;

export interface AgentBridgeHandlers {
  [command: string]: AgentBridgeHandler;
}

interface RpcRequest {
  rpcId:   string;
  command: string;
  params:  Record<string, unknown>;
}

export function useAgentBridge(handlers: AgentBridgeHandlers): void {
  async function onRequest(_event: unknown, req: RpcRequest): Promise<void> {
    if (!req || typeof req.rpcId !== 'string' || typeof req.command !== 'string') return;

    const handler = handlers[req.command];
    if (!handler) {
      ipcRenderer.send(RPC_REPLY, {
        rpcId: req.rpcId,
        ok:    false,
        error: `Unknown CaptureStudio command: ${ req.command }`,
      });
      return;
    }

    try {
      const result = await handler(req.params || {});
      ipcRenderer.send(RPC_REPLY, { rpcId: req.rpcId, ok: true, result });
    } catch (err: any) {
      ipcRenderer.send(RPC_REPLY, {
        rpcId: req.rpcId,
        ok:    false,
        error: err?.message || String(err),
      });
    }
  }

  onMounted(() => {
    ipcRenderer.on(RPC_REQUEST, onRequest);
    ipcRenderer.send(RPC_REGISTER);
  });

  onBeforeUnmount(() => {
    ipcRenderer.send(RPC_UNREGISTER);
    ipcRenderer.removeListener(RPC_REQUEST, onRequest);
  });
}
