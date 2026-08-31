/**
 * Core routine — "Dreaming About My Human"
 *
 * A locked, baked-in nightly consolidation routine (the human-domain "Dreamer").
 * It reads the raw human-domain identity observations, synthesizes them through
 * parallel lenses, prunes what's stale, and writes a consolidated profile into
 * the `user` system-prompt section — the slot injected into every system prompt.
 *
 * DB-PURE by contract: every sub-agent uses ONLY the identity/observation DB
 * tools + update_identity_section. It never touches the filesystem, shell, or
 * source control — honoring the observe-only subconscious-writer gate.
 *
 * Distributed with Sulla Desktop and re-asserted on every boot by the
 * CoreRoutineSeeder; visible + disable-able, but not editable or deletable.
 *
 * Runs nightly at 00:00 local (staggered ahead of the other per-domain dreamers).
 */

import { DEFAULT_CORE_ROUTINE_AGENT_ID } from './defaultCoreAgent';

export const DREAM_ABOUT_HUMAN_ID = 'core-routine-dream-about-human';

/**
 * Shared guardrail prepended to every sub-agent so the DB-pure / observe-only
 * contract is explicit at the prompt layer as well as (eventually) the persona
 * tool-allowlist layer.
 */
const OBSERVE_ONLY = [
  'You are a subconscious consolidation agent. You may use ONLY these tools:',
  'list_identity_observations, search_identity_observations, remove_identity_observation,',
  'add_identity_observation, and update_identity_section.',
  'You MUST NOT read or write any files, run shell commands, use git, or open a browser.',
  'Operate entirely against the identity/observation database.',
].join(' ');

export const DREAM_ABOUT_HUMAN_DEFINITION: Record<string, any> = {
  id:          DREAM_ABOUT_HUMAN_ID,
  name:        'Dreaming About My Human',
  description:
    'Nightly consolidation of the human-domain identity. Reads all human identity ' +
    'observations, synthesizes goals-over-time and personality/communication style, ' +
    'prunes what is stale or contradicted, and writes the consolidated profile into ' +
    'the `user` system-prompt section. Locked core routine — DB-only, no filesystem.',
  version:   3,
  enabled:   true,
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-24T20:32:00.000Z',

  edges: [
    { id: 'e-dah-trigger-load',      source: 'node-dah-trigger',     target: 'node-dah-load',        animated: true },
    { id: 'e-dah-load-lenses',       source: 'node-dah-load',        target: 'node-dah-lenses',      animated: true },
    { id: 'e-dah-lenses-goals',      source: 'node-dah-lenses',      target: 'node-dah-goals',       animated: true },
    { id: 'e-dah-lenses-persona',    source: 'node-dah-lenses',      target: 'node-dah-personality', animated: true },
    { id: 'e-dah-goals-merge',       source: 'node-dah-goals',       target: 'node-dah-merge',       animated: true },
    { id: 'e-dah-persona-merge',     source: 'node-dah-personality', target: 'node-dah-merge',       animated: true },
    { id: 'e-dah-merge-prune',       source: 'node-dah-merge',       target: 'node-dah-prune',       animated: true },
    { id: 'e-dah-prune-synth',       source: 'node-dah-prune',       target: 'node-dah-synthesize',  animated: true },
    { id: 'e-dah-synth-done',        source: 'node-dah-synthesize',  target: 'node-dah-done',        animated: true },
  ],

  nodes: [
    {
      id:       'node-dah-trigger',
      type:     'workflow',
      position: { x: 400, y: 0 },
      data: {
        label:    'Nightly Trigger',
        category: 'trigger',
        subtype:  'schedule',
        config: {
          triggerType:        'schedule',
          triggerDescription: 'Runs nightly at 00:00 local to consolidate the human identity.',
          frequency:          'daily',
          intervalMinutes:    0,
          hour:               0,
          minute:             0,
          dayOfWeek:          0,
          dayOfMonth:         1,
          timezone:           '',
        },
      },
    },
    {
      id:       'node-dah-load',
      type:     'workflow',
      position: { x: 400, y: 130 },
      data: {
        label:    'Load Human Observations',
        category: 'agent',
        subtype:  'tool-call',
        config: {
          toolName: 'list_identity_observations',
          defaults: { domain: 'human' },
        },
      },
    },
    {
      id:       'node-dah-lenses',
      type:     'workflow',
      position: { x: 400, y: 260 },
      data: {
        label:    'Consolidation Lenses',
        category: 'flow-control',
        subtype:  'parallel',
        config:   {},
      },
    },
    {
      id:       'node-dah-goals',
      type:     'workflow',
      position: { x: 200, y: 390 },
      data: {
        label:    'Goals Over Time',
        category: 'agent',
        subtype:  'agent',
        config: {
          agentId:                  DEFAULT_CORE_ROUTINE_AGENT_ID,
          agentName:                'Human Goals Horizon',
          additionalPrompt:         OBSERVE_ONLY,
          successCriteria:          'A concise goals-over-time snapshot for the human.',
          completionContract:       'Exit when the 1-month / 6-month / 2-year snapshot is written.',
          orchestratorInstructions:
            'You have the full set of human-domain identity observations (passed from the load step). ' +
            'Search for more with search_identity_observations {domain:"human"} if needed. ' +
            'Infer what the human is trying to accomplish over three horizons — the next 1 month, ' +
            '6 months, and 2 years — grounded ONLY in the observations. Mark anything speculative as ' +
            'inferred (L1). Output a tight snapshot (<300 words) of goals per horizon. Do not write ' +
            'files. Return the snapshot as your result.',
        },
      },
    },
    {
      id:       'node-dah-personality',
      type:     'workflow',
      position: { x: 600, y: 390 },
      data: {
        label:    'Personality & Communication Style',
        category: 'agent',
        subtype:  'agent',
        config: {
          agentId:                  DEFAULT_CORE_ROUTINE_AGENT_ID,
          agentName:                'Human Personality Reader',
          additionalPrompt:         OBSERVE_ONLY,
          successCriteria:          'A personality + how-to-work-with-them snapshot for the human.',
          completionContract:       'Exit when the personality & communication snapshot is written.',
          orchestratorInstructions:
            'Using ONLY the human-domain identity observations, characterize the human: personality, ' +
            'working style, communication preferences, what earns their trust, what frustrates them, ' +
            'and how Sulla should best communicate and work alongside them. Ground every claim in the ' +
            'observations; label reasoned conclusions as inferred (L1). Output a tight snapshot ' +
            '(<300 words). Do not write files. Return the snapshot as your result.',
        },
      },
    },
    {
      id:       'node-dah-merge',
      type:     'workflow',
      position: { x: 400, y: 520 },
      data: {
        label:    'Lenses Complete',
        category: 'flow-control',
        subtype:  'merge',
        config:   { strategy: 'wait-all' },
      },
    },
    {
      id:       'node-dah-prune',
      type:     'workflow',
      position: { x: 400, y: 650 },
      data: {
        label:    'Prune Stale Observations',
        category: 'agent',
        subtype:  'agent',
        config: {
          agentId:                  DEFAULT_CORE_ROUTINE_AGENT_ID,
          agentName:                'Human Observation Pruner',
          additionalPrompt:         OBSERVE_ONLY,
          successCriteria:          'Stale, duplicate, or contradicted human observations archived.',
          completionContract:       'Exit when pruning is complete and a short summary is returned.',
          orchestratorInstructions:
            'Review the human-domain identity observations for redundancy and staleness. ' +
            'For clear duplicates (same fact stated multiple times), keep the highest-certainty row ' +
            'and archive the rest with remove_identity_observation. Archive observations that a newer ' +
            'observation directly contradicts (keep the newer). Be conservative — when in doubt, keep. ' +
            'Never delete via any means other than remove_identity_observation. Return a one-line ' +
            'summary of how many rows you archived and why. Do not write files.',
        },
      },
    },
    {
      id:       'node-dah-synthesize',
      type:     'workflow',
      position: { x: 400, y: 780 },
      data: {
        label:    'Write Consolidated Profile',
        category: 'agent',
        subtype:  'agent',
        config: {
          agentId:                  DEFAULT_CORE_ROUTINE_AGENT_ID,
          agentName:                'Human Profile Synthesizer',
          additionalPrompt:         OBSERVE_ONLY,
          successCriteria:          'The `user` system-prompt section holds a fresh consolidated human profile.',
          completionContract:       'Exit when update_identity_section has written the `user` section.',
          orchestratorInstructions:
            'You have two lens snapshots (goals-over-time and personality/communication) plus the pruned ' +
            'observation set. Synthesize a single consolidated human profile written in the second person ' +
            '("You are working with ...") that Sulla can carry in every system prompt. Keep it under 500 ' +
            'words, factual, and free of speculation presented as fact. Then persist it by calling ' +
            'update_identity_section with { "id": "user", "content": <the profile> }. Do NOT write any ' +
            'files. Confirm the section was written and return the profile you saved.',
        },
      },
    },
    {
      id:       'node-dah-done',
      type:     'workflow',
      position: { x: 400, y: 910 },
      data: {
        label:    'Done',
        category: 'io',
        subtype:  'response',
        config: {
          responseTemplate: 'Dreamed about the human — consolidated profile written to the `user` section.',
        },
      },
    },
  ],

  viewport: { x: 0, y: 0, zoom: 1 },
};
