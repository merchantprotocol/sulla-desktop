/**
 * Capture Studio RPC bus — lets main-process code (agent tools) reach
 * into the CaptureStudio renderer window and invoke composable methods
 * (useRecorder, useMediaSources, useAudioDriver) that only exist there.
 *
 * Shape:
 *   1. CaptureStudio.vue mounts → sends `capture-studio:rpc-register`.
 *      Main records the WebContents id as the active bridge target.
 *   2. Main code calls `callCaptureStudio(command, params, timeoutMs)`.
 *      The bus auto-opens CaptureStudio if no renderer is registered,
 *      waits for the register ping (up to `openWaitMs`), assigns a
 *      unique rpcId, and sends `capture-studio:rpc` with { rpcId,
 *      command, params } to the renderer.
 *   3. Renderer resolves the command and sends
 *      `capture-studio:rpc-reply` { rpcId, ok, result?, error? } back.
 *      The bus matches the reply to the pending promise by rpcId.
 *   4. If the renderer never replies within `timeoutMs`, the promise
 *      rejects with a timeout error.
 *
 * Keeping this dumb on purpose: one active bridge at a time (the most
 * recently mounted CaptureStudio), serialized per rpcId. No retries,
 * no queueing. Agent tools can retry themselves.
 */

import { BrowserWindow, WebContents, ipcMain } from 'electron';

import { getWindow, openCaptureStudio } from '@pkg/window';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

const RPC_REQUEST  = 'capture-studio:rpc';
const RPC_REPLY    = 'capture-studio:rpc-reply';
const RPC_REGISTER = 'capture-studio:rpc-register';
const RPC_UNREGISTER = 'capture-studio:rpc-unregister';

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject:  (reason: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}

interface RpcReply {
  rpcId:   string;
  ok:      boolean;
  result?: unknown;
  error?:  string;
}

interface CallOptions {
  /** How long to wait for the renderer's reply before rejecting. */
  timeoutMs?: number;
  /** How long to wait for a CaptureStudio to register after we auto-open it. */
  openWaitMs?: number;
}

let activeContents: WebContents | null = null;
const pending = new Map<string, PendingRpc>();
const registerWaiters: Array<() => void> = [];

export function isCaptureStudioReady(): boolean {
  return !!activeContents && !activeContents.isDestroyed();
}

/**
 * Call a CaptureStudio renderer command. Resolves with the renderer's
 * result or rejects with an Error. Auto-opens CaptureStudio if it isn't
 * currently registered; the caller blocks until the new renderer's
 * listener comes up (or openWaitMs elapses).
 */
export async function callCaptureStudio<T = unknown>(
  command: string,
  params: Record<string, unknown> = {},
  opts: CallOptions = {},
): Promise<T> {
  const { timeoutMs = 10_000, openWaitMs = 6_000 } = opts;

  if (!isCaptureStudioReady()) {
    // Bring up the window if it's missing. openCaptureStudio() creates
    // or focuses. Either way, the renderer will dispatch RPC_REGISTER
    // once it mounts.
    const existing = getWindow('capture-studio');
    if (!existing || existing.isDestroyed()) {
      openCaptureStudio();
    } else if (!existing.isVisible()) {
      existing.show();
    }
    await waitForRegister(openWaitMs);
  }

  const contents = activeContents;
  if (!contents || contents.isDestroyed()) {
    throw new Error('CaptureStudio renderer did not come up.');
  }

  const rpcId = `rpc_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(rpcId);
      reject(new Error(`CaptureStudio RPC "${ command }" timed out after ${ timeoutMs }ms.`));
    }, timeoutMs);

    pending.set(rpcId, {
      resolve: (v) => resolve(v as T),
      reject,
      timer,
    });

    contents.send(RPC_REQUEST, { rpcId, command, params });
  });
}

function waitForRegister(timeoutMs: number): Promise<void> {
  if (isCaptureStudioReady()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onRegister = () => resolve();
    registerWaiters.push(onRegister);
    setTimeout(() => {
      const i = registerWaiters.indexOf(onRegister);
      if (i >= 0) registerWaiters.splice(i, 1);
      if (!isCaptureStudioReady()) {
        reject(new Error(`CaptureStudio did not register within ${ timeoutMs }ms.`));
      }
    }, timeoutMs);
  });
}

/** Wire up the register/reply IPC endpoints. Call once at app startup. */
export function registerCaptureStudioRpc(): void {
  ipcMain.on(RPC_REGISTER, (event: Electron.IpcMainEvent) => {
    activeContents = event.sender;
    console.log('[CaptureStudioRpc] registered wc id=', event.sender.id);
    // Notify everything waiting for a CaptureStudio to come up.
    const waiters = registerWaiters.splice(0);
    for (const fn of waiters) {
      try { fn(); } catch { /* ignore */ }
    }
    // If the renderer goes away, clear our reference + reject pending.
    event.sender.once('destroyed', () => {
      if (activeContents === event.sender) activeContents = null;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('CaptureStudio window closed before reply.'));
        pending.delete(id);
      }
    });
  });

  ipcMain.on(RPC_UNREGISTER, (event: Electron.IpcMainEvent) => {
    if (activeContents === event.sender) {
      activeContents = null;
      console.log('[CaptureStudioRpc] unregistered');
    }
  });

  ipcMain.on(RPC_REPLY, (_event: Electron.IpcMainEvent, reply: RpcReply) => {
    if (!reply || typeof reply.rpcId !== 'string') return;
    const p = pending.get(reply.rpcId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(reply.rpcId);
    if (reply.ok) p.resolve(reply.result);
    else p.reject(new Error(reply.error || 'CaptureStudio RPC failed.'));
  });

  // Also clean up when the window itself is closed.
  BrowserWindow.getAllWindows().forEach((w) => {
    w.on('closed', () => {
      if (activeContents && activeContents.isDestroyed()) activeContents = null;
    });
  });
}
