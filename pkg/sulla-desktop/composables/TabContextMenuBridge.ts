// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface Request {
  id:       string;
  select:   (action: string) => void;
  onClosed: () => void;
}

/** One shell subscription, independent of the number of mounted headers. */
export class TabContextMenuBridge {
  private current?: Request;

  connect(ipc: Pick<typeof ipcRenderer, 'on' | 'removeListener'>): () => void {
    const onSelected = (_event: unknown, id: string, action: string) => {
      const request = this.take(id);

      request?.select(action);
    };
    const onClosed = (_event: unknown, id: string) => this.close(id);

    ipc.on('tab-context-menu:selected', onSelected);
    ipc.on('tab-context-menu:closed', onClosed);
    return () => {
      ipc.removeListener('tab-context-menu:selected', onSelected);
      ipc.removeListener('tab-context-menu:closed', onClosed);
      if (this.current) this.close(this.current.id);
    };
  }

  open(request: Request): void {
    if (this.current) this.close(this.current.id);
    this.current = request;
  }

  close(id: string): void {
    this.take(id);
  }

  private take(id: string): Request | undefined {
    const request = this.current;

    if (request?.id !== id) return undefined;
    this.current = undefined;
    request.onClosed();
    return request;
  }
}

export const tabContextMenuBridge = new TabContextMenuBridge();
