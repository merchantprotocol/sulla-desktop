// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { TabHoverRequest } from '../shared/TabStripPopup';

/** The window may retain hidden headers; each header can cancel only its own request. */
export class TabHoverController {
  private timer?:   number;
  private shownId?: string;

  constructor(
    private readonly clock: Pick<Window, 'setTimeout' | 'clearTimeout'>,
    private readonly show: (request: TabHoverRequest) => void,
    private readonly hide: (id: string) => void,
  ) {}

  schedule(readVisibleRequest: () => TabHoverRequest | undefined): void {
    this.cancel();
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      const request = readVisibleRequest();

      if (!request) return;
      this.shownId = request.id;
      this.show(request);
    }, 350);
  }

  cancel(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.shownId !== undefined) this.hide(this.shownId);
    this.shownId = undefined;
  }
}
