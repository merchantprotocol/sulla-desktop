// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Pages reachable from the Studio sidebar. The first three are the Use
// Cases views PackagesTab renders itself; the rest come from the parent
// through the `section` slot.
export type StudioSection =
  | 'browse' | 'library' | 'updates'
  | 'workflows' | 'skills' | 'agents' | 'recipes'
  | 'live' | 'usage';

export const USE_CASE_SECTIONS: StudioSection[] = ['browse', 'library', 'updates'];

const ALL_SECTIONS: readonly StudioSection[] = ['browse', 'library', 'updates', 'workflows', 'skills', 'agents', 'recipes', 'live', 'usage'];

export function isStudioSection(value: unknown): value is StudioSection {
  return typeof value === 'string' && (ALL_SECTIONS as readonly string[]).includes(value);
}

// The mode rail has icons for Workflows, Live Agents and Token Usage; every
// other sidebar page belongs to the Use Cases icon.
export function railSubTabFor(section: StudioSection): 'workflows' | 'live' | 'usage' | 'browse' {
  return section === 'workflows' || section === 'live' || section === 'usage' ? section : 'browse';
}
