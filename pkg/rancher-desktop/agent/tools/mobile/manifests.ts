import type { ToolManifest } from '../registry';

/**
 * Mobile read-side tools — query the Sulla Cloud backend (same endpoints
 * the phone hits) so the desktop agent can answer questions about calls,
 * leads, and messages without picking up the phone.
 *
 * All requests use the user's mobile JWT from vault `sulla-cloud/api_token`.
 * Base URL defaults to https://sulla-workers.jonathon-44b.workers.dev, can
 * be overridden via vault `sulla-cloud/mobile_api_url`.
 */
export const mobileToolManifests: ToolManifest[] = [
  {
    name:        'list_calls',
    description: 'List recent calls handled by the AI receptionist (Sulla Mobile). Shows caller, duration, status, and id. Filter by status ("active", "completed", "voicemail").',
    category:    'mobile',
    schemaDef:   {
      limit:  { type: 'number', optional: true, description: 'Max rows (default 20, cap 100).' },
      status: { type: 'string', optional: true, description: 'Filter by call status.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_calls'),
  },
  {
    name:        'get_call',
    description: 'Full details for one call — transcript, AI summary, extracted lead metadata, caller info.',
    category:    'mobile',
    schemaDef:   {
      id: { type: 'string', description: 'Call id (from list_calls).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./get_call'),
  },
  {
    name:        'list_leads',
    description: 'List leads extracted from recent calls — the same rows that appear in the mobile Inbox tab. Filter by qualified_only or urgency.',
    category:    'mobile',
    schemaDef:   {
      limit:          { type: 'number',  optional: true, description: 'Max rows (default 20, cap 100).' },
      qualified_only: { type: 'boolean', optional: true, description: 'If true, only qualified leads.' },
      urgency:        { type: 'string',  optional: true, description: 'Filter by urgency value.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_leads'),
  },
  {
    name:        'list_messages',
    description: 'List SMS and voicemail transcripts shown in the mobile Messages tab. unread_only filters to unread.',
    category:    'mobile',
    schemaDef:   {
      limit:       { type: 'number',  optional: true, description: 'Max rows (default 20, cap 100).' },
      unread_only: { type: 'boolean', optional: true, description: 'If true, only unread.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_messages'),
  },
  {
    name:        'list_devices',
    description: 'List every desktop and mobile device registered to the contractor, annotated with online/offline status. A device is "online" when it has hit the worker within the last 2 minutes (heartbeat or any authenticated call). Useful for checking whether the Sulla Mobile app is reachable before routing something to it. Optionally filter with { online_only: true } or { device_type: "mobile" | "desktop" }.',
    category:    'mobile',
    schemaDef:   {
      online_only: { type: 'boolean', optional: true, description: 'If true, only return devices seen in the last 2 minutes.' },
      device_type: { type: 'enum',    optional: true, enum: ['desktop', 'mobile'], description: 'Filter to desktop or mobile devices only.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_devices'),
  },
  {
    name:        'list_questions',
    description: 'List pending agent questions waiting on the user — the durable inbox behind ask_user_question (survives desktop restart). Each row shows kind (decision/dependency/test), the question, asking agent, originating conversation/task, and expiry. Scoped to the caller: an answerer only sees questions scoped to them. Use get_question for the full card, answer_question to answer.',
    category:    'mobile',
    schemaDef:   {
      limit: { type: 'number', optional: true, description: 'Max rows (default 20, cap 100).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_questions'),
  },
  {
    name:        'get_question',
    description: 'Full card for one agent question — context, recommendation, risk, every question with its selectable options, status, and recorded answers once settled. Scoped to the caller.',
    category:    'mobile',
    schemaDef:   {
      id: { type: 'string', description: 'Question id (from list_questions).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./get_question'),
  },
  {
    name:        'answer_question',
    description: 'Answer a pending agent question from the mobile surface. Persists the answer first (atomic pending->answered claim) and then resumes the asking agent thread if it is live — a double answer or stale submit is rejected without side effects, and if the desktop restarted the answer is still durably recorded. Answers are { question, selected[] } items matching the question texts from get_question.',
    category:    'mobile',
    schemaDef:   {
      id:      { type: 'string', description: 'Question id (from list_questions).' },
      answers: {
        type:        'array',
        description: 'One item per question: the question text and the selected option label(s) (or free-form text).',
        items:       {
          type:       'object',
          properties: {
            question: { type: 'string', description: 'Echo of the question text (correlates the answer).' },
            selected: { type: 'array', items: { type: 'string' }, description: 'Selected option label(s) and/or free-form text.' },
          },
        },
      },
      answered_by: { type: 'string', optional: true, description: 'Identity of the human answering, recorded for attribution.' },
    },
    operationTypes: ['read', 'update'],
    loader:         () => import('./answer_question'),
  },
];
