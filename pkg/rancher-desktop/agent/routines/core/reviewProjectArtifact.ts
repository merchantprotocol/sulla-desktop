/**
 * Protected Projects in-review owner.
 *
 * TaskDispatcherService performs the atomic claim and activates this graph.
 * Reviewers inspect canonical artifacts independently, then a separate agent
 * synthesizes the only machine-consumed disposition. The service persists the
 * evidence and state transition in one transaction.
 */

import { DEFAULT_CORE_ROUTINE_AGENT_ID } from './defaultCoreAgent';

export const REVIEW_PROJECT_ARTIFACT_ID = 'core-routine-review-project-artifact';

export const REVIEWER_NODE_IDS = [
  'node-review-code',
  'node-review-deliverable',
  'node-review-risk',
] as const;

export const ARTIFACT_VERIFICATION_ADAPTERS = {
  code_pr:                  { adapter: 'github-pr', tools: ['github_get_pr', 'github_get_pr_files', 'github_check_runs', 'git_status', 'git_diff', 'git_log', 'git_blame'] },
  documentation:            { adapter: 'document-read', tools: ['read_file', 'file_search', 'list', 'snapshot', 'text', 'screenshot'] },
  marketing_campaign:       { adapter: 'system-record-read', tools: ['get_project_item', 'list_task_comments', 'list', 'snapshot', 'text', 'screenshot'] },
  research:                 { adapter: 'source-read', tools: ['read_file', 'file_search', 'list', 'snapshot', 'text', 'screenshot'] },
  data_spreadsheet:         { adapter: 'spreadsheet-read', tools: ['read_file', 'file_search', 'list', 'snapshot', 'text', 'screenshot'] },
  design_media:             { adapter: 'media-read', tools: ['read_file', 'file_search', 'list', 'snapshot', 'screenshot'] },
  operations_configuration: { adapter: 'configuration-read', tools: ['read_file', 'file_search', 'get_project_item', 'list_task_comments', 'calendar_get', 'calendar_list'] },
  projects_evidence:        { adapter: 'projects-read', tools: ['get_project_item', 'list_task_comments', 'list_task_waits'] },
} as const;

const READ_ONLY = [
  'You are an independent read-only reviewer. Inspect canonical evidence; summaries are only leads.',
  'Never edit files or records, change Projects state, commit, push, merge, deploy, spend money,',
  'send external communication, or perform destructive actions. Return evidence, not instructions to trust you.',
].join(' ');

const reviewerNode = (
  id: string,
  label: string,
  x: number,
  instructions: string,
) => ({
  id,
  type:     'workflow',
  position: { x, y: 320 },
  data:     {
    label,
    category: 'agent',
    subtype:  'agent',
    config:   {
      agentId:                  DEFAULT_CORE_ROUTINE_AGENT_ID,
      agentName:                label,
      additionalPrompt:         READ_ONLY,
      inheritParentToolPolicy:  true,
      successCriteria:          'A source-backed review mapped to the task acceptance contract and immutable artifact generation.',
      completionContract:       'Return JSON with applicable, verdict, checks, findings, artifactRef, artifactHash, and confidence.',
      orchestratorInstructions: `${ READ_ONLY } Claimed task and canonical evidence: {{trigger}} Classification: {{Classify Artifact and Risk}} ${ instructions } Return JSON only with keys applicable, verdict (pass|repairable|replan|external_wait|blocked), checks, findings, artifactRef, artifactHash, and confidence. If this lens is not applicable, set applicable=false and explain why; do not invent evidence.`,
    },
  },
});

export const REVIEW_PROJECT_ARTIFACT_DEFINITION: Record<string, any> = {
  id:          REVIEW_PROJECT_ARTIFACT_ID,
  name:        'Review Projects Artifact',
  description: 'Locked core routine that owns in_review: generation-safe claims, independent artifact-aware review, one synthesized verdict, durable evidence, and deterministic disposition.',
  version:     3,
  laneContract: {
    input:  'project.lane-entry.v1',
    output: 'project.lane-outcome.v1',
  },
  enabled:     true,
  createdAt:   '2026-08-23T19:30:00.000Z',
  updatedAt:   '2026-08-24T20:32:00.000Z',
  nodes:       [
    {
      id:       'node-review-trigger',
      type:     'workflow',
      position: { x: 500, y: 0 },
      data:     {
        label:    'Claimed Review Generation',
        category: 'trigger',
        subtype:  'manual',
        config:   {
          triggerType:        'manual',
          triggerDescription: 'Internal activation after the dispatcher atomically claims the current in_review artifact generation.',
        },
      },
    },
    {
      id:       'node-review-classify',
      type:     'workflow',
      position: { x: 500, y: 150 },
      data:     {
        label:    'Classify Artifact and Risk',
        category: 'agent',
        subtype:  'agent',
        config:   {
          agentId:                  DEFAULT_CORE_ROUTINE_AGENT_ID,
          agentName:                'Review Classifier',
          additionalPrompt:         READ_ONLY,
          inheritParentToolPolicy:  true,
          successCriteria:          'Artifact types, immutable reference, acceptance criteria, dependencies, and risk lenses are identified from source evidence.',
          completionContract:       'Return JSON with generationHash, artifactTypes, artifacts, acceptanceCriteria, dependencies, risk, and requiredReviewLenses.',
          orchestratorInstructions: `${ READ_ONLY } Inspect the claimed Projects task, bounded comments, originating execution evidence, and canonical artifacts. The trigger contains the already-bound generation and structured artifact components; never replace or omit them. Classify one or more of code_pr, documentation, marketing_campaign, research, data_spreadsheet, design_media, operations_configuration, or projects_evidence. For each component return type, canonicalRef, url, immutable hash, adapter, and code boolean. Use the named read-only adapter for each non-code system of record. For every code component, resolve the remote draft PR, base, full head SHA, diff, and claimed checks. Return JSON only with keys generationHash, artifactTypes, artifacts, acceptanceCriteria, dependencies, risk, and requiredReviewLenses.`,
        },
      },
    },
    {
      id:       'node-review-fanout',
      type:     'workflow',
      position: { x: 500, y: 245 },
      data:     {
        label:    'Fan Out Independent Reviewers',
        category: 'flow-control',
        subtype:  'parallel',
        config:   {},
      },
    },
    reviewerNode(
      'node-review-code',
      'Code and PR Reviewer',
      160,
      'For code or mixed work, inspect the remote PR state, draft flag, base, exact head SHA, diff, commits, callers and consumers, focused test/typecheck/lint/build evidence, migrations, backward compatibility, unrelated changes, and tenant/security boundaries. Re-resolve the remote head before returning. For non-code work, mark this lens not applicable.',
    ),
    reviewerNode(
      'node-review-deliverable',
      'Authoritative Deliverable Reviewer',
      500,
      'For documentation, research, marketing, data, design, operations, or mixed work, open the authoritative artifact and verify readability, completeness, stable identity, provenance, and every acceptance criterion. Never treat unpublished outbound work as sent. For pure code work, still verify PR description and Projects custody, then limit findings to that lens.',
    ),
    reviewerNode(
      'node-review-risk',
      'Regression and Authority Reviewer',
      840,
      'Independently challenge the plan and artifact for missed consumers, hidden coupling, security/privacy/tenant boundaries, destructive behavior, authority violations, rollout/rollback gaps, and tests that do not prove the claim. Distinguish reversible defects, wrong-plan failures, genuine external waits, and irreversible human-only gates.',
    ),
    {
      id:       'node-review-merge',
      type:     'workflow',
      position: { x: 500, y: 500 },
      data:     {
        label:    'Independent Reviews Complete',
        category: 'flow-control',
        subtype:  'merge',
        config:   { strategy: 'wait-all' },
      },
    },
    {
      id:       'node-review-synthesize',
      type:     'workflow',
      position: { x: 500, y: 650 },
      data:     {
        label:    'Synthesize Disposition',
        category: 'agent',
        subtype:  'agent',
        config:   {
          agentId:                  DEFAULT_CORE_ROUTINE_AGENT_ID,
          agentName:                'Review Verdict Synthesizer',
          additionalPrompt:         READ_ONLY,
          inheritParentToolPolicy:  true,
          successCriteria:          'One conservative verdict is tied to the current immutable artifact and every material finding.',
          completionContract:       'Return one JSON object matching the protected disposition and generic pipeline-transition schema.',
          orchestratorInstructions: `${ READ_ONLY } Original evidence: {{trigger}} Classification: {{Classify Artifact and Risk}} Code review: {{Code and PR Reviewer}} Deliverable review: {{Authoritative Deliverable Reviewer}} Risk review: {{Regression and Authority Reviewer}} Reconcile conflicts conservatively. Echo the trigger generationHash exactly and return every structured artifact component. PASS requires applicable reviewers to prove every criterion against the same current artifact generation; every code component must carry its freshly resolved exact PR head. PASS uses transition {mode:"next"}. Every other disposition selects a configured exception stage with {mode:"specific",stageKey}; in the bundled core template use todo for REPAIRABLE, planning for REPLAN, and blocked for EXTERNAL_WAIT or BLOCKED. Return JSON only: {"disposition":"PASS|REPAIRABLE|REPLAN|EXTERNAL_WAIT|BLOCKED","generationHash":"64 hex","transition":{"mode":"next"}|{"mode":"specific","stageKey":"configured-stage-key"},"custody":{"workKind":"code|non_code","artifactId":"stable id","evidence":{},"provenance":{"actor":"review-routine"}},"artifactTypes":["code_pr"],"artifacts":[{"type":"code_pr","canonicalRef":"owner/repo#1","url":"...","hash":"40-64 hex","adapter":"github-pr","code":true}],"artifactType":"compatibility summary","artifactRef":"stable ref or full SHA","artifactUrl":"...","artifactHash":"40-64 hex SHA/hash","summary":"...","checks":[...],"findings":[...],"wait":{"kind":"github_checks|human_gate|scheduled_time|external_job","targetKey":"stable key","target":{},"fingerprint":"optional hex","nextCheckAt":"optional ISO","dueAt":"optional ISO"}|null}.`,
        },
      },
    },
    {
      id:       'node-review-done',
      type:     'workflow',
      position: { x: 500, y: 810 },
      data:     {
        label:    'Disposition Ready',
        category: 'io',
        subtype:  'response',
        config:   { responseTemplate: 'Independent artifact review completed; the dispatcher is recording its generation-bound disposition.' },
      },
    },
  ],
  edges: [
    { id: 'e-review-trigger-classify', source: 'node-review-trigger', target: 'node-review-classify', animated: true },
    { id: 'e-review-classify-fanout', source: 'node-review-classify', target: 'node-review-fanout', animated: true },
    { id: 'e-review-fanout-code', source: 'node-review-fanout', target: 'node-review-code', animated: true },
    { id: 'e-review-fanout-deliverable', source: 'node-review-fanout', target: 'node-review-deliverable', animated: true },
    { id: 'e-review-fanout-risk', source: 'node-review-fanout', target: 'node-review-risk', animated: true },
    { id: 'e-review-code-merge', source: 'node-review-code', target: 'node-review-merge', animated: true },
    { id: 'e-review-deliverable-merge', source: 'node-review-deliverable', target: 'node-review-merge', animated: true },
    { id: 'e-review-risk-merge', source: 'node-review-risk', target: 'node-review-merge', animated: true },
    { id: 'e-review-merge-synthesize', source: 'node-review-merge', target: 'node-review-synthesize', animated: true },
    { id: 'e-review-synthesize-done', source: 'node-review-synthesize', target: 'node-review-done', animated: true },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
};
