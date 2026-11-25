// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

interface Request {
  id:       string;
  select:   (tabId: string) => void;
  onClosed: () => void;
}

/** Looks up a native menu reply without retaining an IPC listener for every parked header. */
export class TabAttentionMenuOwner {
  private current?: Request;

  open(request: Request): void {
    if (this.current) this.close(this.current.id);
    this.current = request;
  }

  select(id: unknown, tabId: string): void {
    if (this.current?.id === id) this.current?.select(tabId);
  }

  close(id: string): void {
    const request = this.current;

    if (request?.id !== id) return;
    this.current = undefined;
    request.onClosed();
  }
}
