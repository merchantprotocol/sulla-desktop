import type { ToolManifest } from '../registry';

export const metaToolManifests: ToolManifest[] = [
  {
    name:        'add_observational_memory',
    description: 'Use this tool to store the observations you make into long-term memory.',
    category:    'observation',
    schemaDef:   {
      priority: { type: 'enum', enum: ['🔴', '🟡', '⚪'], default: '🟡' },
      content:  { type: 'string', description: 'One sentence only — extremely concise, always include the context' },
    },
    operationTypes: ['create', 'read', 'update', 'delete'],
    loader:         () => import('./add_observational_memory'),
  },
  {
    name:        'exec',
    description: 'Run any shell command inside a fully isolated sandboxed Linux VM with root access. Safe to install packages, compile code, delete files, manage services, or run any system command. Access all other tools through sulla cli here.',
    category:    'meta',
    schemaDef:   {
      command: { type: 'string', optional: true, description: 'The exact shell command to run' },
      cmd:     { type: 'string', optional: true, description: 'Alias for command' },
      cwd:     { type: 'string', optional: true, description: 'Working directory inside the VM to run the command in' },
      timeout: { type: 'number', optional: true, description: 'Timeout in milliseconds (default 120000). Use higher values for long-running installs.' },
      stdin:   { type: 'string', optional: true, description: 'Optional stdin data to pipe into the command' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./exec'),
  },
  {
    name:        'remove_observational_memory',
    description: 'Remove a specific observational memory by its ID to delete it from long-term memory.',
    category:    'observation',
    schemaDef:   {
      id: { type: 'string', description: 'The 4-character ID of the memory to remove.' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./remove_observational_memory'),
  },
  {
    name:        'file_search',
    description: 'Fast semantic search across any directory. Faster and more comprehensive than find or grep — use this as your default search tool. Searches file contents and filenames using QMD vector indexing. Automatically indexes on first search.',
    category:    'meta',
    schemaDef:   {
      query:   { type: 'string', description: 'Search query — keywords, concepts, or questions to match against file contents and names.' },
      dirPath: { type: 'string', optional: true, description: 'Absolute path to the directory to search in. Defaults to the user home directory if not provided.' },
      limit:   { type: 'number', optional: true, description: 'Maximum number of results to return (default 20).' },
      reindex: { type: 'boolean', optional: true, description: 'Force re-index the directory before searching.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./meta_search'),
  },
  {
    name:        'read_file',
    description: 'Read the contents of a file with optional line range. Returns line-numbered content and the total line count. Can also list directory contents.',
    category:    'meta',
    schemaDef:   {
      path:      { type: 'string', description: 'Path to the file to read. Supports ~ for home directory.' },
      startLine: { type: 'number', optional: true, description: 'First line to read (1-indexed). Defaults to 1.' },
      endLine:   { type: 'number', optional: true, description: 'Last line to read (1-indexed). Defaults to end of file.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./read_file'),
  },
  {
    name:        'write_file',
    description: 'Write or overwrite file contents. Creates parent directories if needed. Restricted to the home directory.',
    category:    'observation',
    schemaDef:   {
      path:    { type: 'string', description: 'Path to the file to write. Supports ~ for home directory.' },
      content: { type: 'string', description: 'The full content to write to the file.' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./write_file'),
  },
  {
    name:        'browse_tools',
    description: 'Search available tools by category or keyword. Returns formatted sulla CLI usage for each tool with descriptions, parameters, and exec examples. Use this to discover what tools are available before calling them.',
    category:    'meta',
    schemaDef:   {
      category: { type: 'string', optional: true, description: 'Tool category to list (e.g. docker, github, slack, redis, pg, playwright, calendar, n8n, kubectl, lima, chrome, vault, extensions, rdctl, meta, agents, skills, bridge).' },
      query:    { type: 'string', optional: true, description: 'Keyword to search tool names and descriptions across all categories.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./browse_tools'),
  },
];
