// SPDX-License-Identifier: GPL-2.0-or-later
import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

/** Keeps paid listing actions tied to Workers' explicit ownership result. */
export class MarketplacePurchasePolicy {
  shouldBuy(row: Pick<MarketplaceBrowseRow, 'is_paid' | 'owned'>): boolean {
    return row.is_paid === true && row.owned !== true;
  }

  canInstall(row: Pick<MarketplaceBrowseRow, 'is_paid' | 'owned'>): boolean {
    return row.is_paid !== true || row.owned === true;
  }
}
