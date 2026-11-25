// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ToolManifest } from '../registry';

export const metaToolManifests: ToolManifest[] = [
  {
    name:        'upsert_conversation_keywords',
    description: 'Observer-only database writer for salient terms from the completed conversation turn. Canonicalizes and upserts terms by (term, thread_id), bumping hit_count and last_seen on repeats.',
    category:    'observation',
    schemaDef:   {
      terms:                    { type: 'array', description: 'Salient terms only (not stopwords, prose, or secrets); maximum 100.', items: { type: 'string' } },
      thread_id:                { type: 'string', description: 'Parent conversation thread id.' },
      conversation_history_id:  { type: 'string', optional: true, nullable: true, description: 'Parent conversation_history row id, when known.' },
      channel_id:               { type: 'string', optional: true, nullable: true, description: 'Parent channel id, when known.' },
      agent_id:                 { type: 'string', optional: true, nullable: true, description: 'Parent agent id, when known.' },
      source:                   { type: 'enum', optional: true, default: 'subconscious', enum: ['primary', 'subconscious', 'worker'], description: 'Writer source; use subconscious here.' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./upsert_conversation_keywords'),
  },
  {
    name:        'search_conversation_keywords',
    description: 'Read-only search for the Conversation Reader over the conversation_keywords index. Pass term (or query) for exact canonical-term match, falling back to pg_trgm fuzzy match, falling back to ILIKE over conversation_history title/summary/last_summary; or pass thread_id to list every indexed keyword for that thread. Deliberately includes conversations hidden from the primary UI (subconscious/worker channels) — that is the point of this tool.',
    category:    'observation',
    schemaDef:   {
      term:      { type: 'string', optional: true, description: 'Term to search for (exact -> fuzzy -> title/summary fallback). Provide this or thread_id.' },
      query:     { type: 'string', optional: true, description: 'Alias for term.' },
      thread_id: { type: 'string', optional: true, description: 'List every indexed keyword for this thread id instead of searching by term.' },
      limit:     { type: 'number', optional: true, description: 'Max results to return (default 20).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./search_conversation_keywords'),
  },
  {
    name:        'search_conversation_logs',
    description: 'Read-only search over ~/sulla/logs/ for the Conversation Reader. Pass thread_id to resolve that conversation\'s specific log file(s) (channel-scoped .log plus the conv_<id>.jsonl event stream); omit it to scan all thread-scoped log files within a recency window (since / days). Add keyword to filter to matching content lines instead of whole-file listings/previews. Excludes global non-thread-scoped infra logs (chat.log, dispatcher.log, index.log, etc).',
    category:    'observation',
    schemaDef:   {
      thread_id: { type: 'string', optional: true, description: 'Conversation/thread id to resolve log files for. Provide this or rely on the recency window below.' },
      keyword:   { type: 'string', optional: true, description: 'Case-insensitive substring to filter matched files down to content lines.' },
      since:     { type: 'string', optional: true, description: 'ISO 8601 timestamp lower bound for the recency window (ignored when thread_id is set).' },
      days:      { type: 'number', optional: true, description: 'Recency window in days from now, used when since is omitted (ignored when thread_id is set).' },
      limit:     { type: 'number', optional: true, description: 'Max files or matching lines to return (default 50, max 200).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./search_conversation_logs'),
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
    name:        'exechost',
    description: 'LAST RESORT host shell — runs a command on the HOST macOS machine, NOT the Sulla VM. Default to regular exec (VM sandbox) for everyday work; home files are already mounted into the VM. Use exechost ONLY when the parent host MUST be used (host-only binaries/GUI apps, host Docker Desktop, tools unavailable in the VM, or explicit user request). Uses the user\'s login shell (/bin/zsh or /bin/bash) so PATH includes Homebrew/nvm/rbenv. Silent output, no Terminal window. Requires "Allow access to the host machine" in Preferences → Application → Administrative Access. Prefer this over AppleScript→Terminal when host execution is truly required.',
    category:    'meta',
    schemaDef:   {
      command: { type: 'string', optional: true, description: 'The exact shell command to run on the host' },
      cmd:     { type: 'string', optional: true, description: 'Alias for command' },
      cwd:     { type: 'string', optional: true, description: 'Working directory on the host to run the command in (absolute path)' },
      timeout: { type: 'number', optional: true, description: 'Timeout in milliseconds (default 60000). Values under 1000 are treated as seconds.' },
      stdin:   { type: 'string', optional: true, description: 'Optional stdin data to pipe into the command' },
      foreground: { type: 'boolean', optional: true, description: 'Default false: `open` commands get -g so apps launch in the background without stealing the user\'s focus/Space. Set true only when the app must come to the front.' },
    },
    operationTypes: ['execute'],
    loader:         () => import('./exechost'),
  },
  {
    name:        'ask_user_question',
    description: 'Save one or more multiple-choice questions in For You. Your parent agent may answer or pass a plain question; the human may answer at any time. Replies identify who answered. End this turn and wait; do not re-ask or proceed with dependent work.',
    category:    'meta',
    schemaDef:   {
      questions: {
        type:        'array',
        description: '1–4 questions to ask. Each renders as its own card with selectable options.',
        items:       {
          type:       'object',
          properties: {
            question:    { type: 'string', description: 'The full question text shown to the user.' },
            header:      { type: 'string', description: 'Short label/chip shown above the question (≤ ~12 chars), e.g. "Auth method".' },
            multiSelect: { type: 'boolean', description: 'Set true to let the user pick multiple options. Default false (single choice).' },
            task:        { type: 'boolean', description: 'Set true when you need the user to DO something you cannot (run a command on their Mac, set a secret, sign in, approve something outside Sulla). Renders a task card with a Done button; options default to Done.' },
            command:     { type: 'string', description: 'For a task: the exact shell command for the user to run, shown with a Copy button. Never include secret values.' },
            options:     {
              type:        'array',
              description: '2–4 distinct options the user can choose from.',
              items:       {
                type:       'object',
                properties: {
                  label:       { type: 'string', description: 'The option text the user selects.' },
                  description: { type: 'string', description: 'Optional one-line explanation of what this option means or implies.' },
                },
              },
            },
          },
        },
      },
      timeoutMs: { type: 'number', optional: true, description: 'Timeout in ms (min 5000, max 1800000, default 300000 = 5 min). On timeout resolves with no selection.' },
    },
    operationTypes: ['read'],
    // Waits on a human for timeoutMs (default 300 s); a 15 s read deadline would cut it off.
    deadlineMs:     305_000,
    loader:         () => import('./ask_user_question'),
  },
  {
    name:        'file_search',
    description: 'Fast full-text keyword search (BM25-ranked) across any directory PLUS the bundled memory seed (agent + tool reference) by default. Faster than find or grep for multi-word queries — use this as your default search tool. Matches file contents and filenames. Small directories are live-scanned (always fresh); large ones use an incremental on-disk index built automatically, with coverage reported when partial. Pass includeSullaKnowledge:false to skip the bundled memory seed second pass.',
    category:    'meta',
    schemaDef:   {
      query:            { type: 'string', description: 'Search query — keywords, concepts, or questions to match against file contents and names.' },
      dirPath:          { type: 'string', optional: true, description: 'Absolute path to the primary directory to search in. Defaults to the user home directory.' },
      limit:            { type: 'number', optional: true, description: 'Maximum number of results to return per directory (default 20).' },
      reindex:          { type: 'boolean', optional: true, description: 'Force re-index the directory(ies) before searching.' },
      includeSullaKnowledge: { type: 'boolean', optional: true, description: 'Whether to also search the bundled memory seed pack (default true). Set false to limit search to dirPath only.' },
      includeSullaDocs: { type: 'boolean', optional: true, description: 'Legacy alias for includeSullaKnowledge.' },
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
    name:        'recall_conversations',
    description: 'Search and read the on-disk conversation logs (~/sulla/logs/conv_*.jsonl) — the training-formatted JSONL transcripts of every past user-facing conversation (subconscious agents are never logged here). Unlike search_conversations (which matches DB titles/summaries), this searches the actual message CONTENT and returns transcripts. action:"search" finds past conversations by keyword and returns each hit\'s id, date, title, and a matching snippet; action:"read" renders one conversation\'s full transcript by id. Use this to recall what was actually said/decided in earlier conversations.',
    category:    'memory',
    schemaDef:   {
      action: { type: 'enum', enum: ['search', 'read'], description: 'search: keyword content-search across all conversation logs. read: render one conversation transcript by id.' },
      query:  { type: 'string', optional: true, description: 'Keywords to match against message content. Required for search.' },
      id:     { type: 'string', optional: true, description: 'Conversation id (from a search result). Required for read.' },
      limit:  { type: 'number', optional: true, description: 'Max search results to return (default 8, max 20).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./recall_conversations'),
  },
  {
    name:        'browse_tools',
    description: 'Discover available sulla CLI tools by category or keyword. Returns ready-to-run `sulla <category>/<tool>` commands with descriptions and parameter JSON. IMPORTANT: the commands it returns are NOT directly callable tools — you invoke each one by passing the full command string to the `exec` tool (e.g. exec({command: "sulla docker/ps \'{}\'"})). NEVER call execute_workflow for any command listed here — execute_workflow is only for named Sulla workflows. Call this before attempting any sulla CLI invocation you are unsure about.',
    category:    'meta',
    schemaDef:   {
      category: { type: 'string', optional: true, description: 'Tool category to list (e.g. docker, github, slack, redis, pg, playwright, calendar, chrome, vault, extensions, meta, agents, skills, bridge).' },
      query:    { type: 'string', optional: true, description: 'Keyword to search tool names and descriptions across all categories.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./browse_tools'),
  },
];
