// Pages reachable from the Studio sidebar. The first three are the Use
// Cases views PackagesTab renders itself; the rest come from the parent
// through the `section` slot.
export type StudioSection =
  | 'browse' | 'library' | 'updates'
  | 'workflows' | 'skills' | 'agents' | 'recipes'
  | 'live' | 'usage';

export const USE_CASE_SECTIONS: StudioSection[] = ['browse', 'library', 'updates'];
