// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Mutable page state shared by the views: the item list, filters and the detail
// generation counter that drops stale reveal responses.
export class VaultState {
  constructor() {
    this.items = [];
    this.selectedId = '';
    this.category = 'all';
    this.accessFilter = 'all';
    this.query = '';
    this.detailGeneration = 0;
    this.editingItem = null;
    this.setupCreatesVault = false;
    this.pendingRecoveryCode = '';
  }

  nextDetailGeneration() { this.detailGeneration += 1; return this.detailGeneration; }

  itemById(id) { return this.items.find(item => item.id === id); }
}
