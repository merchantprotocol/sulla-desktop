import type { WorkflowNodeCategory, WorkflowNodeSubtype } from './types';

export interface NodeTypeDefinition {
  subtype:             WorkflowNodeSubtype;
  category:            WorkflowNodeCategory;
  label:               string;
  description:         string;
  iconSvg:             string;
  useImageIcon?:       boolean;
  defaultLabel:        string;
  defaultConfig:       () => Record<string, any>;
  hasMultipleOutputs?: boolean;
  /** When true, the node renders custom positioned handles instead of the default top/bottom pair */
  hasCustomHandles?:   boolean;
}

// SVG icons — all stroke-based, 20x20 viewBox, matching TriggerNodePanel.vue pattern
const ICONS = {
  manual: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',

  schedule: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/><path d="M17.7 17.7l2.8 2.8"/></svg>',

  chatCompletions: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',

  agent: '', // Uses <img> with robot-512-nobg.png

  router: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 6a9 9 0 0 1 9 0"/><path d="M6 12a6 6 0 0 1 6 6"/></svg>',

  condition: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 9-9 9-9-9z"/></svg>',

  wait: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',

  loop: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',

  parallel: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="8"/><line x1="12" y1="8" x2="5" y2="14"/><line x1="12" y1="8" x2="19" y2="14"/><line x1="5" y1="14" x2="5" y2="22"/><line x1="19" y1="14" x2="19" y2="22"/></svg>',

  merge: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="2" x2="5" y2="10"/><line x1="19" y1="2" x2="19" y2="10"/><line x1="5" y1="10" x2="12" y2="16"/><line x1="19" y1="10" x2="12" y2="16"/><line x1="12" y1="16" x2="12" y2="22"/></svg>',

  subWorkflow: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2"/><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',

  userInput: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',

  response: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',

  transfer: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><line x1="21" y1="3" x2="14" y2="10"/><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/></svg>',

  orchestratorPrompt: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" y1="10" x2="15" y2="10"/></svg>',

  function: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3 H4 V21 H9"/><path d="M15 3 H20 V21 H15"/><path d="M10 9 H14"/><path d="M10 15 H14"/></svg>',
};

export const NODE_REGISTRY: NodeTypeDefinition[] = [
  // ── Triggers ──
  // The palette only exposes `manual` and `schedule`. The legacy subtypes
  // (calendar, chat-app, heartbeat, sulla-desktop, workbench, chat-completions)
  // are subsumed by `manual` — any external invocation (UI, chat, calendar
  // event, API call, heartbeat tick) routes through the manual trigger now.
  {
    subtype:       'manual',
    category:      'trigger',
    label:         'Manual',
    description:   'Run on demand — from chat, the UI, calendar events, or any external signal',
    iconSvg:       ICONS.manual,
    defaultLabel:  'Manual Trigger',
    defaultConfig: () => ({ triggerType: 'manual', triggerDescription: '' }),
  },
  {
    subtype:       'schedule',
    category:      'trigger',
    label:         'Schedule',
    description:   'Cron-based recurring schedule',
    iconSvg:       ICONS.schedule,
    defaultLabel:  'Schedule Trigger',
    defaultConfig: () => ({ triggerType: 'schedule', triggerDescription: '', frequency: 'daily', intervalMinutes: 15, hour: 9, minute: 0, dayOfWeek: 1, dayOfMonth: 1, timezone: '' }),
  },

  // ── Agent ──
  {
    subtype:       'agent',
    category:      'agent',
    label:         'Agent',
    description:   'Run a Sulla agent',
    iconSvg:       ICONS.agent,
    useImageIcon:  true,
    defaultLabel:  'Agent',
    defaultConfig: () => ({ agentId: null, agentName: '', additionalPrompt: '', orchestratorInstructions: '', successCriteria: '', completionContract: '' }),
  },
  {
    subtype:       'tool-call',
    category:      'agent',
    label:         'Tool Call',
    description:   'Call a native tool (filesystem, docker, redis, etc.)',
    iconSvg:       '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    defaultLabel:  'Tool Call',
    defaultConfig: () => ({ toolName: '', defaults: {} }),
  },
  {
    subtype:       'integration-call',
    category:      'agent',
    label:         'Integration Call',
    description:   'Call an integration API endpoint',
    iconSvg:       '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="4"/></svg>',
    defaultLabel:  'Integration Call',
    defaultConfig: () => ({ integrationSlug: '', endpointName: '', accountId: 'default', defaults: {}, preCallDescription: '' }),
  },
  {
    subtype:       'orchestrator-prompt',
    category:      'agent',
    label:         'Prompt',
    description:   'Send a message to the orchestrating agent',
    iconSvg:       ICONS.orchestratorPrompt,
    defaultLabel:  'Prompt',
    defaultConfig: () => ({ prompt: '' }),
  },
  {
    subtype:       'function',
    category:      'agent',
    label:         'Function',
    description:   'Invoke a user-defined function in a sandboxed runtime',
    iconSvg:       ICONS.function,
    defaultLabel:  'Function',
    defaultConfig: () => ({
      functionRef:         '',
      inputs:              {},
      integrationAccounts: {},
      timeoutOverride:     null,
    }),
  },

  // ── Routing ──
  {
    subtype:            'router',
    category:           'routing',
    label:              'Router',
    description:        'LLM-based classification routing',
    iconSvg:            ICONS.router,
    defaultLabel:       'Router',
    defaultConfig:      () => ({ classificationPrompt: '', routes: [] }),
    hasMultipleOutputs: true,
  },
  {
    subtype:            'condition',
    category:           'routing',
    label:              'Condition',
    description:        'Rule-based if/else branching',
    iconSvg:            ICONS.condition,
    defaultLabel:       'Condition',
    defaultConfig:      () => ({ rules: [], combinator: 'and' }),
    hasMultipleOutputs: true,
  },

  // ── Flow Control ──
  {
    subtype:       'wait',
    category:      'flow-control',
    label:         'Wait / Delay',
    description:   'Pause execution for a duration',
    iconSvg:       ICONS.wait,
    defaultLabel:  'Wait',
    defaultConfig: () => ({ delayAmount: 5, delayUnit: 'seconds' }),
  },
  {
    subtype:          'loop',
    category:         'flow-control',
    label:            'Loop',
    description:      'Repeat until condition or max iterations',
    iconSvg:          ICONS.loop,
    defaultLabel:     'Loop',
    defaultConfig:    () => ({ loopMode: 'iterations', maxIterations: 10, condition: '', conditionMode: 'template', orchestratorPrompt: '' }),
    hasCustomHandles: true,
  },
  {
    subtype:       'parallel',
    category:      'flow-control',
    label:         'Parallel',
    description:   'Fork execution into parallel branches',
    iconSvg:       ICONS.parallel,
    defaultLabel:  'Parallel',
    defaultConfig: () => ({}),
  },
  {
    subtype:       'merge',
    category:      'flow-control',
    label:         'Merge',
    description:   'Join parallel branches back together',
    iconSvg:       ICONS.merge,
    defaultLabel:  'Merge',
    defaultConfig: () => ({ strategy: 'wait-all' }),
  },
  {
    subtype:       'sub-workflow',
    category:      'flow-control',
    label:         'Sub-workflow',
    description:   'Execute another workflow as a step',
    iconSvg:       ICONS.subWorkflow,
    defaultLabel:  'Sub-workflow',
    defaultConfig: () => ({ workflowId: null, awaitResponse: true, agentId: null, orchestratorPrompt: '' }),
  },

  // ── I/O ──
  {
    subtype:       'user-input',
    category:      'io',
    label:         'User Input',
    description:   'Pause and wait for user response',
    iconSvg:       ICONS.userInput,
    defaultLabel:  'User Input',
    defaultConfig: () => ({ promptText: '' }),
  },
  {
    subtype:       'response',
    category:      'io',
    label:         'Response',
    description:   'Send a response to the user',
    iconSvg:       ICONS.response,
    defaultLabel:  'Response',
    defaultConfig: () => ({ responseTemplate: '' }),
  },
  {
    subtype:       'transfer',
    category:      'io',
    label:         'Transfer',
    description:   'Hand off to another workflow',
    iconSvg:       ICONS.transfer,
    defaultLabel:  'Transfer',
    defaultConfig: () => ({ targetWorkflowId: null }),
  },
  {
    subtype:       'desktop-notification',
    category:      'io',
    label:         'Desktop Notification',
    description:   'Publish a macOS/Windows desktop notification via the notify_user tool',
    iconSvg:       '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    defaultLabel:  'Notify User',
    defaultConfig: () => ({ toolName: 'notify_user', defaults: { title: '', message: '' } }),
  },
];

export function getNodeDefinition(subtype: WorkflowNodeSubtype): NodeTypeDefinition | undefined {
  return NODE_REGISTRY.find(n => n.subtype === subtype);
}

export function getNodesByCategory(category: WorkflowNodeCategory): NodeTypeDefinition[] {
  return NODE_REGISTRY.filter(n => n.category === category);
}

export const CATEGORY_LABELS: Record<WorkflowNodeCategory, string> = {
  trigger:        'Triggers',
  agent:          'Agent',
  routing:        'Routing',
  'flow-control': 'Flow Control',
  io:             'I/O',
};

export const CATEGORY_ORDER: WorkflowNodeCategory[] = [
  'trigger',
  'agent',
  'routing',
  'flow-control',
  'io',
];
