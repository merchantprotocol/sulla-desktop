import type { ToolManifest } from '../registry';

export const bookmarkToolManifests: ToolManifest[] = [
  {
    name:        'bookmarks_list',
    description: 'List bookmarks from the app Bookmarks pane as a nested tree or as the direct children of one folder. Returns bookmark metadata without favicon blobs.',
    category:    'bookmarks',
    schemaDef:   {
      format:   { type: 'enum', enum: ['tree', 'flat'], optional: true, default: 'tree', description: 'Nested tree (default), or a flat list of direct children.' },
      folderId: { type: 'string', optional: true, description: 'Folder whose contents to list. Omit for the root.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list'),
  },
  {
    name:           'bookmarks_search',
    description:    'Search bookmark and folder titles and bookmark URLs. Use this to find saved research sources, dashboards, deploy URLs, and agent-owned items.',
    category:       'bookmarks',
    schemaDef:      { query: { type: 'string', description: 'Case-insensitive text to find in titles or URLs.' } },
    operationTypes: ['read'],
    loader:         () => import('./search'),
  },
  {
    name:        'bookmarks_add',
    description: 'Save a useful link, research source, dashboard, deploy URL, artifact, or other agent-owned item in the app Bookmarks pane. Defaults to a root Sulla folder and avoids duplicate URLs within the destination folder.',
    category:    'bookmarks',
    schemaDef:   {
      url:        { type: 'string', description: 'Bookmark URL accepted by Sulla Desktop.' },
      title:      { type: 'string', optional: true, description: 'Display title. Defaults from the URL.' },
      folderId:   { type: 'string', optional: true, description: 'Existing destination folder id.' },
      folderPath: { type: 'string', optional: true, description: 'Slash-separated path such as Sulla/Research. Missing folders are created.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./add'),
  },
  {
    name:        'bookmarks_create_folder',
    description: 'Create a folder in the app Bookmarks pane to organize links and agent-owned items.',
    category:    'bookmarks',
    schemaDef:   {
      title:    { type: 'string', description: 'Folder title.' },
      parentId: { type: 'string', optional: true, description: 'Parent folder id. Omit to create at the root.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./create_folder'),
  },
  {
    name:        'bookmarks_update',
    description: 'Rename a bookmark or folder, or change a bookmark URL in the app Bookmarks pane.',
    category:    'bookmarks',
    schemaDef:   {
      id:    { type: 'string', description: 'Bookmark or folder id.' },
      title: { type: 'string', optional: true, description: 'New title.' },
      url:   { type: 'string', optional: true, description: 'New bookmark URL. Folders cannot have URLs.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./update'),
  },
  {
    name:        'bookmarks_move',
    description: 'Move or reorder a bookmark or folder in the app Bookmarks pane.',
    category:    'bookmarks',
    schemaDef:   {
      id:       { type: 'string', description: 'Bookmark or folder id.' },
      parentId: { type: 'string', optional: true, description: 'Destination folder id. Pass an empty string for the root; omit to keep the current parent.' },
      index:    { type: 'number', optional: true, description: 'Zero-based position. Omit to append in the destination.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./move'),
  },
  {
    name:        'bookmarks_remove',
    description: 'Remove a bookmark or folder from the app Bookmarks pane. Non-empty folders require recursive: true and are removed with all descendants.',
    category:    'bookmarks',
    schemaDef:   {
      id:        { type: 'string', description: 'Bookmark or folder id.' },
      recursive: { type: 'boolean', optional: true, default: false, description: 'Required to remove a non-empty folder and all descendants.' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./remove'),
  },
];
