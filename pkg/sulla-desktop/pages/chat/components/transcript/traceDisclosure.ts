// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { reactive, ref } from 'vue';

/** Owns disclosure state for one transcript instance and exposes Vue-reactive reads. */
export class TraceDisclosureController {
  private readonly opened = reactive(new Set<string>());
  private readonly allOpen = ref(false);
  isOpen(id: string): boolean { return this.allOpen.value || this.opened.has(id); }
  toggle(id: string): void {
    if (this.isOpen(id)) { this.opened.delete(id); if (this.allOpen.value) this.allOpen.value = false; }
    else this.opened.add(id);
  }
  openAll(): void { this.allOpen.value = true; }
  closeAll(): void { this.allOpen.value = false; this.opened.clear(); }
  toggleAll(): void { this.allOpen.value ? this.closeAll() : this.openAll(); }
  get isAllOpen(): boolean { return this.allOpen.value; }
}
