// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type ExtensionUISlot = 'sidebar_entry' | 'settings_tab' | 'chat_card';
export interface ExtensionUIContribution { extensionId: string; slot: ExtensionUISlot; id: string; label: string; icon?: string; component: string; order?: number }
export class ExtensionUIRegistry {
  private readonly contributions = new Map<string, ExtensionUIContribution>();
  register(item: ExtensionUIContribution): () => void {
    const key = `${ item.extensionId }:${ item.slot }:${ item.id }`;
    this.contributions.set(key, Object.freeze({ ...item }));
    return () => this.contributions.delete(key);
  }
  clear(): void { this.contributions.clear() }
  list(slot?: ExtensionUISlot): readonly ExtensionUIContribution[] {
    return [...this.contributions.values()].filter(item => !slot || item.slot === slot).sort((a, b) => (a.order ?? 10) - (b.order ?? 10));
  }
}
export const extensionUI = new ExtensionUIRegistry();
