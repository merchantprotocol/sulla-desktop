/**
 * The return contract every delegated agent finishes with — hidden workers and
 * agent tabs alike. A contract is a name, an optional description and an
 * optional JSON schema. When the caller gives no schema the default contract
 * applies: `{ status: completed|blocked|failed, summary, output }`, which is
 * what a plain worker would have said anyway.
 *
 * Pure module (Ajv only): the registry, the return tool and the tab opener all
 * share it, and tests can import it without a database.
 */

import Ajv from 'ajv';

export interface AgentContractSpec {
  name:         string;
  description?: string;
  schema?:      Record<string, unknown>;
}

export type ContractReturnStatus = 'completed' | 'blocked' | 'failed';

export const DEFAULT_CONTRACT_NAME = 'result';

/** The shape a contract without a caller schema is checked against. */
export const DEFAULT_RESULT_SCHEMA: Record<string, unknown> = {
  type:       'object',
  required:   ['status', 'summary'],
  properties: {
    status:  { type: 'string', enum: ['completed', 'blocked', 'failed'] },
    summary: { type: 'string', minLength: 1 },
    output:  {},
  },
};

export const UI_TEST_ISSUES_SCHEMA: Record<string, unknown> = {
  type:                 'object',
  additionalProperties: false,
  required:             ['summary', 'issues'],
  properties:           {
    summary: {
      type:                 'object',
      additionalProperties: false,
      required:             ['pass', 'fail', 'blocked', 'notRun'],
      properties:           {
        pass:    { type: 'number' },
        fail:    { type: 'number' },
        blocked: { type: 'number' },
        notRun:  { type: 'number' },
      },
    },
    issues: {
      type:  'array',
      items: {
        type:                 'object',
        additionalProperties: false,
        required:             ['id', 'title', 'severity', 'url', 'steps', 'expected', 'actual', 'status'],
        properties:           {
          id:         { type: 'string' },
          title:      { type: 'string' },
          severity:   { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
          url:        { type: 'string' },
          steps:      { type: 'array', items: { type: 'string' } },
          expected:   { type: 'string' },
          actual:     { type: 'string' },
          screenshot: { type: 'string' },
          viewport:   { type: 'string' },
          status:     { type: 'string', enum: ['open'] },
        },
      },
    },
  },
};

const PRESETS: Record<string, AgentContractSpec> = {
  'ui-test-issues': {
    name:        'ui-test-issues',
    description: 'UI test totals and every issue found, with reproduction evidence.',
    schema:      UI_TEST_ISSUES_SCHEMA,
  },
};

/** Caller input → a contract spec. Unknown input becomes the default contract. */
export function normalizeContract(input: unknown): AgentContractSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { name: DEFAULT_CONTRACT_NAME };
  const raw = input as Record<string, unknown>;
  const name = String(raw.name ?? DEFAULT_CONTRACT_NAME).trim() || DEFAULT_CONTRACT_NAME;
  const preset = PRESETS[name];
  if (preset && !raw.schema) return preset;
  return {
    name,
    ...(typeof raw.description === 'string' && raw.description.trim() ? { description: raw.description.trim() } : {}),
    ...(raw.schema && typeof raw.schema === 'object' && !Array.isArray(raw.schema) ? { schema: raw.schema as Record<string, unknown> } : {}),
  };
}

/** Throws when a caller-supplied schema does not compile. */
export function assertContractSchema(contract: AgentContractSpec): void {
  if (!contract.schema) return;
  try {
    new Ajv().compile(contract.schema);
  } catch (error) {
    throw new Error(`Contract schema is invalid: ${ (error as Error).message }`);
  }
}

/**
 * Build the value checked against the contract from a return call. A caller
 * schema gets `result` exactly as sent, or — when `result` is absent — the
 * call's own fields, since children often send the schema's fields at the top
 * level. The default contract also accepts `status`, `summary`, `output` at the
 * top level so a plain worker can return without wrapping anything.
 */
export function contractCandidate(contract: AgentContractSpec, input: {
  result?:  unknown;
  status?:  unknown;
  summary?: unknown;
  output?:  unknown;
  [field: string]: unknown;
}): unknown {
  if (contract.schema) {
    if (input.result !== undefined) return input.result;
    const { jobId: _jobId, contractId: _contractId, ...fields } = input;
    return fields;
  }
  const result = input.result && typeof input.result === 'object' && !Array.isArray(input.result)
    ? input.result as Record<string, unknown>
    : undefined;
  const output = input.output !== undefined
    ? input.output
    : result && 'output' in result ? result.output : (result ?? input.result);
  return {
    status:  input.status ?? result?.status ?? 'completed',
    summary: typeof input.summary === 'string' && input.summary.trim() ? input.summary.trim() : result?.summary,
    ...(output === undefined ? {} : { output }),
  };
}

/** Validate a candidate; returns the mismatch text, or null when it fits. */
export function validateContractResult(contract: AgentContractSpec, candidate: unknown): string | null {
  const ajv = new Ajv({ allErrors: true });
  let validate: Ajv.ValidateFunction;
  try {
    validate = ajv.compile(contract.schema ?? DEFAULT_RESULT_SCHEMA);
  } catch (error) {
    return `Contract schema is invalid: ${ (error as Error).message }`;
  }
  if (validate(candidate)) return null;
  return ajv.errorsText(validate.errors, { separator: '; ' });
}

/** Terminal status a returned contract implies for its job task. */
export function contractReturnStatus(contract: AgentContractSpec, result: unknown): ContractReturnStatus {
  if (contract.schema) return 'completed';
  const status = (result as any)?.status;
  return status === 'blocked' || status === 'failed' ? status : 'completed';
}

/** Human/orchestrator-readable rendering of a returned contract. */
export function formatContractResult(contract: AgentContractSpec, result: any, summary?: string): string {
  const lines: string[] = [];
  if (summary?.trim()) lines.push(summary.trim());
  if (!contract.schema && result && typeof result === 'object') {
    if (!summary?.trim() && typeof result.summary === 'string') lines.push(result.summary.trim());
    if (result.output !== undefined) {
      lines.push(typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2));
    }
  } else if (contract.name === 'ui-test-issues' && result && typeof result === 'object') {
    const counts = result.summary ?? {};
    lines.push(`PASS ${ counts.pass ?? 0 }  ·  FAIL ${ counts.fail ?? 0 }  ·  BLOCKED ${ counts.blocked ?? 0 }  ·  NOT RUN ${ counts.notRun ?? 0 }`);
    const issues = Array.isArray(result.issues) ? result.issues : [];
    if (issues.length === 0) lines.push('No issues found.');
    for (const issue of issues) {
      lines.push(`${ String(issue.severity ?? '').toUpperCase() } · ${ issue.id ?? 'issue' } · ${ issue.title ?? 'Untitled' }`);
      if (issue.url) lines.push(String(issue.url));
      if (issue.actual) lines.push(`Actual: ${ issue.actual }`);
      if (issue.expected) lines.push(`Expected: ${ issue.expected }`);
    }
  } else {
    lines.push(JSON.stringify(result, null, 2));
  }
  return lines.filter(Boolean).join('\n');
}

/** The output text a returned contract hands the parent. */
export function contractResultOutput(contract: AgentContractSpec, result: unknown, summary?: string): string {
  const body = formatContractResult(contract, result, summary);
  // The preset renders a digest; the parent still needs the exact value.
  return contract.name === 'ui-test-issues'
    ? `${ body }\n\nStructured result:\n${ JSON.stringify(result, null, 2) }`
    : body;
}

/** Footer appended to every delegated brief, hidden or tab. */
export function contractFooter(opts: {
  jobId:      string;
  contract:   AgentContractSpec;
  visibility: 'hidden' | 'tab';
}): string {
  const { jobId, contract, visibility } = opts;
  const lines = [
    '---',
    `Return contract (job ${ jobId }): when the work is done, call \`agents/return_result\` (alias \`chat/return_contract\`).`,
    `Contract name: ${ contract.name }`,
  ];
  if (contract.description) lines.push(`Contract description: ${ contract.description }`);
  if (contract.schema) {
    lines.push(`Send \`result\` matching this JSON schema exactly:\n${ JSON.stringify(contract.schema, null, 2) }`);
  } else {
    lines.push('Send `{ "status": "completed" | "blocked" | "failed", "summary": "<one paragraph>", "output": <the deliverable> }`.');
  }
  lines.push(visibility === 'tab'
    ? 'This is a live chat tab: ending a turn does not finish the job. Only return_result closes it. Call `agents/report_progress` at milestones.'
    : contract.schema
      ? 'Ending your turn without returning gets one reminder, then the task fails as no_contract.'
      : 'If you end without returning, your final message is returned as the summary.');
  return lines.join('\n');
}
