import type { FilesItem } from './types';

export const fileNameCollator = new Intl.Collator(undefined, { numeric: true });

export interface FolderAggregate<T extends FilesItem = FilesItem> {
  name: string;
  path: string;
  count: number;
  size: number;
  newest?: T;
  newestTimestamp: number;
  allAgent: boolean;
  hasConflict: boolean;
  hasSyncing: boolean;
  allOnlineOnly: boolean;
}

export interface FolderAggregation<T extends FilesItem = FilesItem> {
  directFiles: T[];
  folders: Map<string, FolderAggregate<T>>;
  timestamps: Map<string, number>;
}

function syncState(file: FilesItem) {
  return file.syncState ?? 'synced';
}

/** Build the direct files and recursive child-folder summaries for one prefix in one file pass. */
export function aggregateFolderChildren<T extends FilesItem>(files: readonly T[], prefix = ''): FolderAggregation<T> {
  const directFiles:T[] = [];
  const folders = new Map<string, FolderAggregate<T>>();
  const timestamps = new Map<string, number>();

  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const relative = file.path.slice(prefix.length);
    if (!relative || relative === '_folder-metadata.yaml') continue;
    const slash = relative.indexOf('/');
    const timestamp = Date.parse(file.updatedAt || '0');
    timestamps.set(file.id, timestamp);
    if (slash < 0 && file.mime !== 'inode/directory') {
      directFiles.push(file);
      continue;
    }

    const name = slash < 0 ? relative : relative.slice(0, slash);
    if (!name || name === '_folder-metadata.yaml') continue;
    let aggregate = folders.get(name);
    if (!aggregate) {
      aggregate = {
        name,
        path: `${prefix}${name}`,
        count: 0,
        size: 0,
        newestTimestamp: Date.parse('0'),
        allAgent: true,
        hasConflict: false,
        hasSyncing: false,
        allOnlineOnly: true,
      };
      folders.set(name, aggregate);
    }
    // Directory marker entries establish the folder but are not folder contents.
    if (slash < 0) continue;
    aggregate.count++;
    aggregate.size += file.size;
    aggregate.allAgent &&= file.createdByType === 'agent-run';
    const state = syncState(file);
    aggregate.hasConflict ||= state === 'conflict';
    aggregate.hasSyncing ||= state === 'syncing';
    aggregate.allOnlineOnly &&= state === 'online-only';
    if (timestamp > aggregate.newestTimestamp) {
      aggregate.newestTimestamp = timestamp;
      aggregate.newest = file;
    }
  }

  return { directFiles, folders, timestamps };
}
