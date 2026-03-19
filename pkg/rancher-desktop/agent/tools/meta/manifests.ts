import type { ToolManifest } from '../registry';

export const metaToolManifests: ToolManifest[] = [
  {
    name:        'add_observational_memory',
    description: 'Use this tool to store the observations you make into long-term memory.',
    category:    'meta',
    schemaDef:   {
      priority: { type: 'enum', enum: ['🔴', '🟡', '⚪'], default: '🟡' },
      content:  { type: 'string', description: 'One sentence only — extremely concise, always include the context' },
    },
    operationTypes: ['create', 'read', 'update', 'delete'],
    loader:         () => import('./add_observational_memory'),
  },
  {
    name:        'exec',
    description: 'Execute a shell command inside the isolated Lima VM and return output. Commands run in a sandboxed virtual machine — NOT on the host OS — so destructive operations are safe. You have full root-level freedom: install packages (apt, apk, npm, pip, etc.), delete files/directories (rm -rf), manage services (systemctl, supervisord), mount filesystems, configure networking, compile software, run database migrations, and any other system-level operation. No command is blocked. Use cwd to set working directory, timeout for long-running operations, and stdin to pipe input.',
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
    name:        'dom_observer',
    description: 'Passive tool — do NOT call this directly. The system automatically delivers DOM change events from open browser tabs as dom_observer tool results. You receive these because you have browser tabs open. To stop receiving events for a tab, close it with browser_tab(action=\'remove\', assetId=\'...\').',
    category:    'meta',
    schemaDef:   {
      assetIds: { type: 'array', optional: true, description: 'Asset IDs of the tabs that emitted events.', items: { type: 'string' } },
    },
    operationTypes: ['read'],
    loader:         () => import('./dom_observer'),
  },
  {
    name:        'browser_tab',
    description: 'Open, navigate, or close browser tabs. Use to browse the web, search, or view any URL. Each tab runs a full browser you can interact with via Playwright tools. Reuse the same assetId to navigate an existing tab to a new URL.',
    category:    'meta',
    schemaDef:   {
      action:    { type: 'enum', enum: ['upsert', 'remove'], default: 'upsert', description: 'upsert creates/updates an asset; remove deletes by assetId.' },
      assetType: { type: 'enum', optional: true, enum: ['iframe', 'document'], description: 'Required for upsert.' },
      assetId:   { type: 'string', optional: true, description: 'Stable asset ID. Reuse the same ID to update an existing tab.' },
      skillSlug: { type: 'string', optional: true, description: 'Optional skill slug to associate with the asset.' },
      title:     { type: 'string', optional: true },
      url:       { type: 'string', optional: true, description: 'Required for iframe upsert.' },
      content:   { type: 'string', optional: true, description: 'Document HTML/markdown content.' },
      active:    { type: 'boolean', optional: true, default: true },
      collapsed: { type: 'boolean', optional: true, default: true },
      refKey:    { type: 'string', optional: true },
    },
    operationTypes: ['create', 'update', 'delete'],
    loader:         () => import('./browser_tab'),
  },
  {
    name:        'remove_observational_memory',
    description: 'Remove a specific observational memory by its ID to delete it from long-term memory.',
    category:    'meta',
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
];
