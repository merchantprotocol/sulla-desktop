// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { TabGroupPopoverChange, TabGroupPopoverRequest } from '@pkg/shared/TabStripPopup';
import type { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface ActivePopover {
  requestId: string;
  onChange:  (change: TabGroupPopoverChange) => void;
  onClosed:  () => void;
}

/** Routes name/color edits from the native popover back to its owning tab strip. */
export class TabGroupPopoverBridge {
  private active?: ActivePopover;
  private connected = false;

  constructor(private readonly ipc: Pick<typeof ipcRenderer, 'on' | 'removeListener' | 'send'>) {}

  open(request: TabGroupPopoverRequest, onChange: (change: TabGroupPopoverChange) => void, onClosed: () => void): void {
    if (this.active) this.close(this.active.requestId);
    this.connect();
    this.active = { requestId: request.requestId, onChange, onClosed };
    this.ipc.send('tab-group-popover:show', request);
  }

  close(requestId: string): void {
    if (this.active?.requestId !== requestId) return;
    const closed = this.take(requestId);

    this.ipc.send('tab-group-popover:hide', requestId);
    closed?.onClosed();
  }

  dispose(): void {
    if (this.active) this.close(this.active.requestId);
    if (!this.connected) return;
    this.connected = false;
    this.ipc.removeListener('tab-group-popover:changed', this.onChanged);
    this.ipc.removeListener('tab-group-popover:closed', this.onClosed);
  }

  private connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.ipc.on('tab-group-popover:changed', this.onChanged);
    this.ipc.on('tab-group-popover:closed', this.onClosed);
  }

  private readonly onChanged = (_event: Electron.IpcRendererEvent, requestId: string, change: TabGroupPopoverChange): void => {
    if (this.active?.requestId === requestId) this.active.onChange(change);
  };

  private readonly onClosed = (_event: Electron.IpcRendererEvent, requestId: string): void => {
    this.take(requestId)?.onClosed();
  };

  private take(requestId: string): ActivePopover | undefined {
    if (this.active?.requestId !== requestId) return undefined;
    const closed = this.active;

    this.active = undefined;
    return closed;
  }
}
