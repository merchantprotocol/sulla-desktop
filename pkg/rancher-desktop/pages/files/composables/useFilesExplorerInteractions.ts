import { computed, ref } from 'vue';

export interface ExplorerLocation {
  collectionId: string;
  section: string;
  path: string;
}

export interface ExplorerTarget {
  key: string;
  fileId?: string;
  folderPath?: string;
  expectedVersionId?: string;
  path: string;
  name: string;
  folder: boolean;
}

export interface ExplorerClipboard {
  collectionId: string;
  mode: 'copy' | 'cut';
  targets: ExplorerTarget[];
}

export interface ExplorerColumns {
  name: number;
  owner: number;
  modified: number;
  size: number;
}

const DEFAULT_COLUMNS:ExplorerColumns = { name: 360, owner: 190, modified: 160, size: 110 };

export function useFilesExplorerInteractions(tabId:string) {
  const backStack = ref<ExplorerLocation[]>([]);
  const forwardStack = ref<ExplorerLocation[]>([]);
  const clipboard = ref<ExplorerClipboard | null>(null);

  function sameLocation(left:ExplorerLocation, right:ExplorerLocation) {
    return left.collectionId === right.collectionId && left.section === right.section && left.path === right.path;
  }

  function visit(current:ExplorerLocation, next:ExplorerLocation) {
    if (sameLocation(current, next)) return;
    backStack.value.push(current);
    forwardStack.value = [];
  }

  function back(current:ExplorerLocation) {
    const next = backStack.value.pop();
    if (!next) return null;
    forwardStack.value.push(current);
    return next;
  }

  function forward(current:ExplorerLocation) {
    const next = forwardStack.value.pop();
    if (!next) return null;
    backStack.value.push(current);
    return next;
  }

  function clearForCollection(collectionId:string) {
    backStack.value = [];
    forwardStack.value = [];
    if (clipboard.value?.collectionId !== collectionId) clipboard.value = null;
  }

  function setClipboard(collectionId:string, mode:'copy' | 'cut', targets:ExplorerTarget[]) {
    clipboard.value = { collectionId, mode, targets: targets.map(target => ({ ...target })) };
  }

  function storageKey(collectionId:string, path:string) {
    return `sulla:files:${ encodeURIComponent(tabId) }:${ encodeURIComponent(collectionId) }:${ encodeURIComponent(path || '/') }`;
  }

  function loadFolderPreferences(collectionId:string, path:string) {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey(collectionId, path)) || '{}') as { sort?:string; direction?:'asc' | 'desc'; columns?:Partial<ExplorerColumns> };
      const columns = { ...DEFAULT_COLUMNS, ...value.columns };

      for (const key of Object.keys(columns) as (keyof ExplorerColumns)[]) columns[key] = Math.max(72, Math.min(720, Number(columns[key]) || DEFAULT_COLUMNS[key]));
      return { sort: value.sort || 'modified', direction: value.direction === 'asc' ? 'asc' as const : 'desc' as const, columns };
    } catch {
      return { sort: 'modified', direction: 'desc' as const, columns: { ...DEFAULT_COLUMNS } };
    }
  }

  function saveFolderPreferences(collectionId:string, path:string, value:{ sort:string; direction:'asc' | 'desc'; columns:ExplorerColumns }) {
    try { localStorage.setItem(storageKey(collectionId, path), JSON.stringify(value)); } catch { /* Browsing remains usable when storage is unavailable. */ }
  }

  return {
    backStack,
    forwardStack,
    clipboard,
    canGoBack: computed(() => backStack.value.length > 0),
    canGoForward: computed(() => forwardStack.value.length > 0),
    visit,
    back,
    forward,
    clearForCollection,
    setClipboard,
    loadFolderPreferences,
    saveFolderPreferences,
  };
}
