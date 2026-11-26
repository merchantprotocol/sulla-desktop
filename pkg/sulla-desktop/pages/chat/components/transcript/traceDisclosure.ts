// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { reactive } from 'vue';

/** Owns disclosure state for one transcript instance and exposes Vue-reactive reads. */
export class TraceDisclosureController {
  private readonly opened = reactive(new Set<string>());
  isOpen(id: string): boolean { return this.opened.has(id); }
  toggle(id: string): void { if (!this.opened.delete(id)) this.opened.add(id); }
}
