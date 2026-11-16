// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Listener shape shared by Electron's ipcMain and the logged ipcMain proxy. */
export type IpcListener = (event: any, ...args: any[]) => any;

/** The slice of ipcMain (or the logged proxy) an IPC controller registers on. */
export interface IpcRegistrar {
  handle(channel: string, listener: IpcListener): void;
}

/** Raw ipcMain surface for controllers that also use fire-and-forget or re-registration. */
export interface IpcMainRegistrar extends IpcRegistrar {
  on(channel: string, listener: IpcListener): unknown;
  removeHandler(channel: string): void;
}

/** One main-process IPC surface. register() wires its channels exactly once. */
export interface IpcController {
  register(): void;
}
