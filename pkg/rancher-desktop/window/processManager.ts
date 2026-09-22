import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { VM_PROBE } from '@pkg/main/processManager/probe';
import { validateTarget, type VmSnapshot } from '@pkg/main/processManager/types';
import paths from '@pkg/utils/paths';
import { createWindow, getWindow, webRoot } from '@pkg/window';

const execute = promisify(execFile);
let registered = false;
let sampling: Promise<VmSnapshot> | undefined;
let confirming = false;

async function probe<T>(request = {}): Promise<T> {
  // Deliberately no host-shell fallback: these controls may only touch the VM.
  if (process.platform === 'win32') {
    throw new Error('Process Manager currently requires the Lima VM on macOS or Linux.');
  }
  try {
    const { stdout } = await execute(paths.limactl, ['shell', '0', '--', 'python3', '-c', VM_PROBE, JSON.stringify(request)], {
      env: { ...process.env, LIMA_HOME: paths.lima }, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    });

    return JSON.parse(stdout);
  } catch (error) {
    const output = (error as { stdout?: string }).stdout;

    if (output) {
      let message: string | undefined;

      try { message = JSON.parse(output).error } catch { /* Non-JSON startup output. */ }
      if (message) { throw new Error(message) }
    }
    throw new Error('Could not reach the VM. It may be starting, stopped, or too busy. Try again shortly.');
  }
}

function authorize(event: IpcMainInvokeEvent) {
  const window = getWindow('process-manager');

  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url.split(/[?#]/)[0] !== `${ webRoot }/process-manager.html`) {
    throw new Error('Process Manager requests must come from its own window.');
  }

  return window;
}

function registerHandlers() {
  if (registered) { return }
  registered = true;
  ipcMain.handle('vm-process-manager:snapshot', (event) => {
    authorize(event);
    sampling ??= probe<VmSnapshot>().finally(() => { sampling = undefined });

    return sampling;
  });
  ipcMain.handle('vm-process-manager:terminate', async(event, input: unknown) => {
    const window = authorize(event);
    const target = validateTarget(input);

    if (confirming) { throw new Error('A quit confirmation is already open.') }
    confirming = true;
    try {
      const snapshot = await probe<VmSnapshot>();
      const process = snapshot.processes.find(p => p.pid === target.pid && p.started === target.started);

      if (snapshot.boot !== target.boot || !process) { throw new Error('Process exited or changed. Refresh and select it again.') }
      if (process.protected) { throw new Error(process.protected) }
      const force = target.signal === 'KILL';
      const choice = await dialog.showMessageBox(window, {
        type:      'warning',
        title:     force ? 'Force Quit Process' : 'Quit Process',
        message:   `${ force ? 'Force quit' : 'Quit' } ${ process.name } (PID ${ process.pid })?`,
        detail:    force ? 'This stops the VM process immediately. Unsaved work may be lost, and its current job may fail.' : 'This asks the VM process to stop. Its current job may be interrupted.',
        buttons:   ['Cancel', force ? 'Force Quit' : 'Quit Process'],
        defaultId: 0,
        cancelId:  0,
        noLink:    true,
      });

      if (choice.response !== 1) { return { sent: false } }
      authorize(event);

      return await probe({ ...target, action: 'terminate' });
    } finally { confirming = false }
  });
}

export function openProcessManager() {
  registerHandlers();
  const window = createWindow('process-manager', `${ webRoot }/process-manager.html`, {
    title:           'Sulla Desktop — VM Process Manager',
    width:           1100,
    height:          760,
    minWidth:        760,
    minHeight:       560,
    backgroundColor: '#111820',
    autoHideMenuBar: true,
    webPreferences:  { nodeIntegration: true, contextIsolation: false, devTools: !app.isPackaged, webSecurity: true },
  });

  app.dock?.show();

  return window;
}
