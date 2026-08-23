/**
 * Core routine — autonomous Projects todo execution.
 *
 * TaskDispatcherService remains the single queue owner and atomically claims a
 * task before activating this graph. The graph classifies the work, delegates
 * to one or more capability-matched workers, independently reviews the real
 * artifact, repairs or replans failed work, and finally verifies durable
 * custody. It never merges, deploys, spends money, or sends communication in
 * the human's name.
 */

export const EXECUTE_PROJECT_TODO_ID = 'core-routine-execute-project-todo';

const SAFETY = [
  'Projects is the only work-state system. Work autonomously to the reversible edge.',
  'Never merge or deploy, spend money, make legal commitments, send external communication in the human\'s name,',
  'or perform destructive shared-system actions. Do not create a parallel markdown task list.',
  'Use the Sulla CLI catalog and bundled docs before inventing a tool or workaround.',
].join(' ');

const AGENT_NODE = (id: string, label: string, y: number, instructions: string, success: string) => ({
  id,
  type:     'workflow',
  position: { x: 400, y },
  data:     {
    label,
    category: 'agent',
    subtype:  'agent',
    config:   {
      agentId:                  'opus-worker',
      agentName:                label,
      additionalPrompt:         SAFETY,
      successCriteria:          success,
      completionContract:       'Return the requested machine-readable result after the artifact or state transition has been verified.',
      orchestratorInstructions: instructions,
    },
  },
});

export const EXECUTE_PROJECT_TODO_DEFINITION: Record<string, any> = {
  id:          EXECUTE_PROJECT_TODO_ID,
  name:        'Execute Projects Todo',
  description: 'Locked core routine for atomic todo execution, capability-based worker fan-out, independent acceptance review, repair/replan routing, and durable artifact custody.',
  version:     1,
  enabled:     true,
  createdAt:   '2026-08-23T19:00:00.000Z',
  updatedAt:   '2026-08-23T19:00:00.000Z',
  nodes:       [
    {
      id:       'node-todo-trigger',
      type:     'workflow',
      position: { x: 400, y: 0 },
      data:     {
        label:    'Claimed Todo',
        category: 'trigger',
        subtype:  'manual',
        config:   {
          triggerType:        'manual',
          triggerDescription: 'Internal activation after TaskDispatcherService atomically claims an eligible todo task.',
        },
      },
    },
    AGENT_NODE(
      'node-todo-classify',
      'Classify Work',
      140,
      `${ SAFETY } Inspect the bounded Projects task snapshot and available configured agents. Classify it as coding/repository, research/analysis, marketing/content, operations/administration, design/media, data/spreadsheet, or mixed/decomposable. Choose 1-10 existing agent IDs based on their real capabilities. Split only independent work; record dependencies where ordering is required. Return JSON only with keys workType, selectedAgents (array of {agentId,reason,assignment,dependsOn}), expectedArtifacts, validation, forbiddenActions, and authoritativeDestination.`,
      'A valid dispatch strategy names capability-matched agents, dependencies, artifacts, validation, gates, and destination.',
    ),
    AGENT_NODE(
      'node-todo-workers',
      'Dynamic Worker Fan-out',
      300,
      `${ SAFETY } Original claimed task: {{trigger}} Classifier decision: {{Classify Work}}. Use the Sulla agent catalog to launch every selected worker, up to 10, in parallel only when assignments are independent and sequentially when dependencies require it. Give each worker the original acceptance criteria, its exact assignment, validation evidence required, forbidden actions, and artifact destination. Wait for every worker, reconcile their results without hiding failures, and return JSON only with keys childIds, workers, combinedOutcome, artifacts, verification, and unresolved. Coding workers must use isolated worktrees and may stop only after commit + Sulla GitHub push + remote draft PR. Non-code workers must update the named authoritative tracker and return its durable ID or URL.`,
      'All selected workers finish or report a concrete failure, with child IDs and durable artifact evidence retained.',
    ),
    AGENT_NODE(
      'node-todo-review',
      'Independent Acceptance Review',
      460,
      `${ SAFETY } You did not execute the work. Original claimed task: {{trigger}} Classifier decision: {{Classify Work}}. Worker results: {{Dynamic Worker Fan-out}}. Independently inspect every acceptance criterion and the actual artifact rather than trusting summaries. For code inspect exact base/head, changed files and consumers, tests/typecheck/lint, security and compatibility, unrelated diff, and draft PR accuracy. For non-code verify the artifact exists in the correct tracker and Projects can retain a durable reference. Return JSON only with verdict (pass|repairable|replan|blocked), findings, evidence, and repairs. Never approve local-only evidence.`,
      'The reviewer gives an evidence-backed verdict after inspecting the actual artifact.',
    ),
    AGENT_NODE(
      'node-todo-repair',
      'Repair or Replan',
      620,
      `${ SAFETY } Original claimed task: {{trigger}} Worker results: {{Dynamic Worker Fan-out}}. Independent verdict: {{Independent Acceptance Review}}. Apply that verdict. On pass, make no changes. On repairable, launch only the targeted repair worker(s), wait, inspect the repair, and re-run the acceptance checks once. On a wrong plan or failed repair, add the evidence to the Projects task and move it to planning with assignee=dispatcher so core routine ${ 'core-routine-plan-project-task' } (#667) owns recovery. On a genuine external gate, add the exact dependency and move it to blocked. Return JSON only with route (pass|repaired|replan|blocked), childIds, actions, evidence, and remainingRisk.`,
      'Failed review cannot silently pass: it is repaired and rechecked, routed to planning, or blocked on a real external gate.',
    ),
    AGENT_NODE(
      'node-todo-custody',
      'Artifact Custody',
      780,
      `${ SAFETY } Original claimed task: {{trigger}} Worker results: {{Dynamic Worker Fan-out}}. Review: {{Independent Acceptance Review}}. Repair route: {{Repair or Replan}}. Perform final custody verification after review/repair. Coding work requires a clean scoped diff, successful relevant validation, a local commit, pushed remote branch, remote draft PR, exact head SHA, and URL. Non-code work requires a readable artifact in the authoritative tracker plus its stable ID/URL/path and a Projects comment linking the outcome and evidence. Inspect the remote/tracker directly. Return JSON only with verdict (pass|replan|blocked), artifactType, artifactLocation, artifactUrl, artifactRef, contentHash, headSha, verificationEvidence, reviewerVerdict, and terminalReason. If any required proof is absent, verdict cannot be pass; route reversible gaps to replan and genuine external gates to blocked.`,
      'Every successful run ends with independently verified durable custody; local-only artifacts are rejected.',
    ),
    AGENT_NODE(
      'node-todo-record',
      'Record Projects Handoff',
      940,
      `${ SAFETY } Original claimed task: {{trigger}} Classifier: {{Classify Work}}. Workers: {{Dynamic Worker Fan-out}}. Review: {{Independent Acceptance Review}}. Repair route: {{Repair or Replan}}. Custody: {{Artifact Custody}}. Write one concise Projects task comment containing the classifier choice, child IDs, reviewer verdict, durable artifact reference, exact SHA/hash when applicable, validation evidence, and next state. Do not mark the task done. A custody pass returns it for independent verifier-pool review; replan and blocked routes must already be recorded by the repair node. Return JSON only with recorded=true, taskId, commentId if available, and nextState (in_review|planning|blocked).`,
      'The authoritative Projects row contains enough evidence to recover the work after restart.',
    ),
    {
      id:       'node-todo-done',
      type:     'workflow',
      position: { x: 400, y: 1080 },
      data:     {
        label:    'Custody Recorded',
        category: 'io',
        subtype:  'response',
        config:   { responseTemplate: 'Todo execution finished with independent review and durable artifact custody recorded in Projects.' },
      },
    },
  ],
  edges: [
    { id: 'e-todo-trigger-classify', source: 'node-todo-trigger', target: 'node-todo-classify', animated: true },
    { id: 'e-todo-classify-workers', source: 'node-todo-classify', target: 'node-todo-workers', animated: true },
    { id: 'e-todo-workers-review', source: 'node-todo-workers', target: 'node-todo-review', animated: true },
    { id: 'e-todo-review-repair', source: 'node-todo-review', target: 'node-todo-repair', animated: true },
    { id: 'e-todo-repair-custody', source: 'node-todo-repair', target: 'node-todo-custody', animated: true },
    { id: 'e-todo-custody-record', source: 'node-todo-custody', target: 'node-todo-record', animated: true },
    { id: 'e-todo-record-done', source: 'node-todo-record', target: 'node-todo-done', animated: true },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
};
