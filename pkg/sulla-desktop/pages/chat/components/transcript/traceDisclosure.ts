// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { reactive, ref } from 'vue';

/** Owns disclosure state for one transcript instance and exposes Vue-reactive reads. */
export class TraceDisclosureController {
  private readonly opened = reactive(new Set<string>());
  private readonly closed = reactive(new Set<string>());
  private readonly allOpen = ref(false);
  isOpen(id: string): boolean { return this.allOpen.value ? !this.closed.has(id) : this.opened.has(id); }
  toggle(id: string): void {
    const exceptions = this.allOpen.value ? this.closed : this.opened;
    if (!exceptions.delete(id)) exceptions.add(id);
  }
  openAll(): void { this.closed.clear(); this.allOpen.value = true; }
  closeAll(): void { this.allOpen.value = false; this.opened.clear(); this.closed.clear(); }
  toggleAll(): void { this.allOpen.value ? this.closeAll() : this.openAll(); }
  get isAllOpen(): boolean { return this.allOpen.value; }
}
