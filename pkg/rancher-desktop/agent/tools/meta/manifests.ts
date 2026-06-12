import type { ToolManifest } from '../registry';

export const metaToolManifests: ToolManifest[] = [
  {
    name:        'add_observational_memory',
    description: 'Use this tool to store the observations you make into long-term memory.',
    category:    'observation',
    schemaDef:   {
      priority: { type: 'string', optional: true, default: '🟡', description: 'Priority tag for this observation. Any short label works — common values: 🔴 / high, 🟡 / medium, ⚪ / low.' },
      content:  { type: 'string', description: 'One sentence only — extremely concise, always include the context' },
    },
    operationTypes: ['create', 'read', 'update', 'delete'],
    loader:         () => import('./add_observational_memory'),
  },
  {
    name:        'exec',
    description: 'Run any shell command inside a fully isolated sandboxed Linux VM with root access. This is ALSO how you invoke every `sulla <category>/<tool>` CLI command surfaced by browse_tools — pass the full `sulla ...` command string as the `command` arg (e.g. command: "sulla github/create_issue \'{\\"title\\":\\"bug\\"}\'"). Safe to install packages, compile code, delete files, or run any system command.',
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
    name:        'request_user_input',
    description: 'Pause and ask the user for an approve/deny decision before proceeding. Renders a prompt card in the chat transcript and BLOCKS until the user clicks Approve or Deny (or the timeout elapses — default 5 min). Returns {decision: "approved" | "denied" | "timed_out", note?}. Use whenever you need explicit consent for a risky or reversible action, or when the next step is ambiguous and you want the user to pick. This is a binary gate, not a free-form question-asker.',
    category:    'meta',
    schemaDef:   {
      question:  { type: 'string', description: 'One-line user-facing summary of what you want approval for. Phrase it as a neutral summary, not a loaded yes/no.' },
      command:   { type: 'string', optional: true, description: 'The exact action / command / payload being approved. Rendered in mono-font for transparency. Omit when the action is obvious from the question.' },
      timeoutMs: { type: 'number', optional: true, description: 'Timeout in ms (min 5000, max 1800000, default 300000 = 5 min). On timeout resolves as "timed_out" — treat as soft deny.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./request_user_input'),
  },
  {
    name:        'file_search',
    description: 'Fast semantic search across any directory PLUS the bundled sulla-docs (agent + tool reference) by default. Faster and more comprehensive than find or grep — use this as your default search tool. Searches file contents and filenames using QMD vector indexing. Automatically indexes on first search. Pass includeSullaDocs:false to skip the sulla-docs second pass.',
    category:    'meta',
    schemaDef:   {
      query:            { type: 'string', description: 'Search query — keywords, concepts, or questions to match against file contents and names.' },
      dirPath:          { type: 'string', optional: true, description: 'Absolute path to the primary directory to search in. Defaults to the user home directory.' },
      limit:            { type: 'number', optional: true, description: 'Maximum number of results to return per directory (default 20).' },
      reindex:          { type: 'boolean', optional: true, description: 'Force re-index the directory(ies) before searching.' },
      includeSullaDocs: { type: 'boolean', optional: true, description: 'Whether to also search the bundled sulla-docs/ reference (default true). Set false to limit search to dirPath only.' },
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
    name:        'recall_index_lookup',
    description: 'Check the Redis citation index for previously-researched digests BEFORE re-reading files or re-searching directories. Pass a topic and/or a list of file paths. Returns trusted digests for files verified unchanged (cheap content-hash check), drops stale entries automatically, and lists which paths/topics need fresh research.',
    category:    'memory',
    schemaDef:   {
      topic: { type: 'string', optional: true, description: 'Topic to look up (e.g. the subject of the user request — "github push auth", "sulla-mobile project"). Normalized internally.' },
      paths: { type: 'array', items: { type: 'string' }, optional: true, description: 'File paths to check for cached digests (e.g. SKILL.md or PROJECT.md paths you would otherwise read).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./recall_index_lookup'),
  },
  {
    name:        'recall_index_store',
    description: 'Persist freshly-researched citation digests into the Redis citation index so future recall passes can reuse them without re-reading source files. Store one entry per file you read (path + the digest you produced), and optionally a topic with citation strings. Entries are verified against file content hashes and expire after 24h unless re-hit.',
    category:    'memory',
    schemaDef:   {
      files: {
        type:        'array',
        optional:    true,
        description: 'Array of {path, digest} objects — one per source file researched. The digest should be the full trusted-citation block produced for that file.',
        items:       {
          type:       'object',
          properties: {
            path:   { type: 'string', description: 'Path of the source file the digest cites.' },
            digest: { type: 'string', description: 'The trusted-citation digest for this file.' },
          },
        },
      },
      topic:     { type: 'string', optional: true, description: 'Topic to file these citations under for future topic lookups.' },
      citations: { type: 'array', items: { type: 'string' }, optional: true, description: 'Citation strings to store under the topic. Required when topic is set.' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./recall_index_store'),
  },
  {
    name:        'browse_tools',
    description: 'Discover available sulla CLI tools by category or keyword. Returns ready-to-run `sulla <category>/<tool>` commands with descriptions and parameter JSON. IMPORTANT: the commands it returns are NOT directly callable tools — you invoke each one by passing the full command string to the `exec` tool (e.g. exec({command: "sulla docker/ps \'{}\'"})). NEVER call execute_workflow for any command listed here — execute_workflow is only for named n8n/Sulla workflows. Call this before attempting any sulla CLI invocation you are unsure about.',
    category:    'meta',
    schemaDef:   {
      category: { type: 'string', optional: true, description: 'Tool category to list (e.g. docker, github, slack, redis, pg, playwright, calendar, n8n, kubectl, lima, chrome, vault, extensions, rdctl, meta, agents, skills, bridge).' },
      query:    { type: 'string', optional: true, description: 'Keyword to search tool names and descriptions across all categories.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./browse_tools'),
  },
];
