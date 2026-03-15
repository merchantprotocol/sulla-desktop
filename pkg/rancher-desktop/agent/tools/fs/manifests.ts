import type { ToolManifest } from '../registry';

export const fsToolManifests: ToolManifest[] = [
  {
    name:        'fs_append_file',
    description: 'Append text content to a file.',
    category:    'fs',
    schemaDef:   {
      path:       { type: 'string', description: 'File path to append to.' },
      content:    { type: 'string', description: 'Content to append to file.' },
      createDirs: { type: 'boolean', optional: true, description: 'Create parent directories if missing. Default true.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./append_file'),
  },
  {
    name:        'fs_copy_path',
    description: 'Copy a file or directory path.',
    category:    'fs',
    schemaDef:   {
      sourcePath:      { type: 'string', description: 'Source file or directory path.' },
      destinationPath: { type: 'string', description: 'Destination file or directory path.' },
      recursive:       { type: 'boolean', optional: true, description: 'Copy directories recursively. Default true.' },
      overwrite:       { type: 'boolean', optional: true, description: 'Overwrite destination when true. Default false.' },
      createDirs:      { type: 'boolean', optional: true, description: 'Create parent directory for destination if missing. Default true.' },
    },
    operationTypes: ['update', 'create'],
    loader:         () => import('./copy_path'),
  },
  {
    name:        'fs_delete_path',
    description: 'Delete a file or directory path.',
    category:    'fs',
    schemaDef:   {
      path:      { type: 'string', description: 'File or directory path to delete.' },
      recursive: { type: 'boolean', optional: true, description: 'Required for directory trees. Default false.' },
      force:     { type: 'boolean', optional: true, description: 'Ignore missing paths. Default true.' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./delete_path'),
  },
  {
    name:        'fs_list_dir',
    description: 'List files and directories at a path.',
    category:    'fs',
    schemaDef:   {
      path:  { type: 'string', description: 'Directory path to list.' },
      depth: { type: 'number', optional: true, description: 'Optional recursion depth. 1 = current directory only (default).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_dir'),
  },
  {
    name:        'fs_mkdir',
    description: 'Create a directory.',
    category:    'fs',
    schemaDef:   {
      path:      { type: 'string', description: 'Directory path to create.' },
      recursive: { type: 'boolean', optional: true, description: 'Create nested directories. Default true.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./mkdir'),
  },
  {
    name:        'fs_move_path',
    description: 'Move or rename a file/directory path.',
    category:    'fs',
    schemaDef:   {
      sourcePath:      { type: 'string', description: 'Source file or directory path.' },
      destinationPath: { type: 'string', description: 'Destination file or directory path.' },
      createDirs:      { type: 'boolean', optional: true, description: 'Create parent directory for destination if missing. Default true.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./move_path'),
  },
  {
    name:        'fs_path_info',
    description: 'Get metadata for a filesystem path.',
    category:    'fs',
    schemaDef:   {
      path: { type: 'string', description: 'Path to inspect.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./path_info'),
  },
  {
    name:        'fs_read_file',
    description: 'Read a text file and return its contents.',
    category:    'fs',
    schemaDef:   {
      path: { type: 'string', description: 'File path to read.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./read_file'),
  },
  {
    name:        'fs_write_file',
    description: 'Write text content to a file.',
    category:    'fs',
    schemaDef:   {
      path:       { type: 'string', description: 'File path to write.' },
      content:    { type: 'string', description: 'Content to write to file.' },
      createDirs: { type: 'boolean', optional: true, description: 'Create parent directories if missing. Default true.' },
    },
    operationTypes: ['update', 'create'],
    loader:         () => import('./write_file'),
  },
];
