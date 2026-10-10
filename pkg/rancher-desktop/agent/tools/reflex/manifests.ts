import type { ToolManifest } from '../registry';

/**
 * Reflex tools — train and inspect Sulla's native Reflex decision engine,
 * which acts on a user's message BEFORE the language model when it is
 * confident it has seen the same request succeed before.
 */
export const reflexToolManifests: ToolManifest[] = [
  {
    name:        'reflex_teach',
    description: 'Teach the Reflex engine what to do for a user message: map an utterance to ONE Sulla tool call (tool + params) that fully satisfies it, or to tool "none" for messages that should never trigger an action. Set positive:false to teach "do NOT do this for this message". Accepts a single example or an `examples` array for bulk training. Only local, non-destructive tools (browser/ui/docker/project/capture/secretary/notify by default) can be taught as positive actions; chat/route_agent is also allowed as the isolated first-message persona-routing target. Teach several phrasings of the same request so the engine generalizes.',
    category:    'reflex',
    schemaDef:   {
      utterance: { type: 'string', optional: true, description: 'What the user says, e.g. "open the doctor container in my browser".' },
      tool:      { type: 'string', optional: true, description: 'Sulla tool registry name (e.g. "tab", "open_tab", "docker_ps"; "browser/tab" also accepted) or "none".' },
      params:    { type: 'object', optional: true, description: 'Exact tool arguments to replay, e.g. {"url":"http://localhost:5199"}.' },
      positive:  { type: 'boolean', optional: true, description: 'false = a counter-example (never do this for this utterance). Default true.' },
      examples:  {
        type:        'array',
        optional:    true,
        description: 'Bulk form: [{utterance, tool, params, positive}] — use instead of the single fields.',
        items:       { type: 'object', properties: { utterance: { type: 'string' }, tool: { type: 'string' }, params: { type: 'object' }, positive: { type: 'boolean' } } },
      },
      source: { type: 'string', optional: true, description: 'Who is teaching: "model" (default), "human", "trainer", or "seed".' },
    },
    operationTypes: ['create'],
    loader:         () => import('./reflex_teach'),
  },
  {
    name:        'reflex_predict',
    description: 'Dry-run the Reflex engine on a message: returns the tool/params it would pick, its confidence, the current threshold, whether it would act, and the nearest training examples. Never executes anything. Use it to check what the engine already knows before teaching, and to verify training worked.',
    category:    'reflex',
    schemaDef:   {
      message: { type: 'string', description: 'The user message to evaluate.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./reflex_predict'),
  },
  {
    name:        'reflex_correct',
    description: 'Tell the Reflex engine one of its decisions was wrong. Records a counter-example for that message and action, and — when you pass the correct tool/params (or tool "none") — teaches the right answer too. Use the decision_id from the <reflex_context> block.',
    category:    'reflex',
    schemaDef:   {
      decision_id: { type: 'string', description: 'The reflex decision id to correct.' },
      tool:        { type: 'string', optional: true, description: 'Correct tool for the message, or "none" if no action should have been taken.' },
      params:      { type: 'object', optional: true, description: 'Correct tool arguments.' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./reflex_correct'),
  },
  {
    name:        'reflex_list_examples',
    description: 'List Reflex training examples, newest first. Filter by text in the utterance or by tool name.',
    category:    'reflex',
    schemaDef:   {
      query:            { type: 'string', optional: true, description: 'Substring to match in the utterance.' },
      tool:             { type: 'string', optional: true, description: 'Only examples for this tool name.' },
      limit:            { type: 'number', optional: true, description: 'Max rows (default 50).' },
      include_archived: { type: 'boolean', optional: true, description: 'Include forgotten examples.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./reflex_list_examples'),
  },
  {
    name:        'reflex_forget',
    description: 'Forget (soft-archive) a Reflex training example by id. It stops influencing decisions immediately but stays recoverable.',
    category:    'reflex',
    schemaDef:   {
      id: { type: 'string', description: 'Example id from reflex_list_examples.' },
    },
    operationTypes: ['delete'],
    loader:         () => import('./reflex_forget'),
  },
  {
    name:        'reflex_stats',
    description: 'Reflex engine status: enabled flag, confidence threshold, allowed categories, example counts, decision counts by outcome, corrections, and the most recent decisions.',
    category:    'reflex',
    schemaDef:   {
      recent: { type: 'number', optional: true, description: 'How many recent decisions to include (default 10).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./reflex_stats'),
  },
  {
    name:        'reflex_export',
    description: 'Export the active Reflex training set as JSON ({version, examples:[{utterance, tool, params, positive}]}) so it can be reviewed or shipped as a production seed. Optionally writes it to a file path; re-import with reflex_teach examples[] and source "seed".',
    category:    'reflex',
    schemaDef:   {
      path: { type: 'string', optional: true, description: 'Absolute file path to write the JSON to. Omit to return it inline.' },
    },
    operationTypes: ['read', 'create'],
    loader:         () => import('./reflex_export'),
  },
];
