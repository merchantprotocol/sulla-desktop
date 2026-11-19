// SPDX-License-Identifier: GPL-2.0-or-later
import type { ModelCandidate } from '../agent/languagemodels/modelRouter';
import type { RoutingProviderInfo } from '../agent/languagemodels/modelRoutingTypes';
import type { AgentStateRow } from './agentState/AgentStateSnapshot';
import type { AgentModelStatusValue } from './agentState/AgentModelStatus';

export const PRODUCT_OWNER = 'account-manager';
export const WORKFLOW_STEPS = [
  { id: 'lead', title: 'Scope & acceptance criteria', agent: PRODUCT_OWNER },
  { id: 'mockup', title: 'Mockup', agent: 'mockup-designer' },
  { id: 'build', title: 'Build & review', agent: 'coding-manager' },
  { id: 'implementation', title: 'Implementation', agent: null },
  { id: 'review', title: 'Independent code review', agent: null },
  { id: 'acceptance', title: 'Acceptance & break-it checks', agent: 'ui-test-manager' },
] as const;

export type ProductOwnerStep = typeof WORKFLOW_STEPS[number]['id'];
export type DelegatedWorkflowStep = Exclude<ProductOwnerStep, 'lead'>;

export function isProductOwnerStep(value: unknown): value is ProductOwnerStep {
  return WORKFLOW_STEPS.some(step => step.id === value);
}

export interface WorkflowChoice {
  agentSlug?: string;
  /** Empty uses the agent's existing routing. Nonempty is a closed, ordered subscription list. */
  candidates: ModelCandidate[];
  independentReview?: boolean;
}

export interface WorkflowPlan {
  canEdit: boolean;
  providers: RoutingProviderInfo[];
  agents: { slug: string; name: string }[];
  steps: Partial<Record<ProductOwnerStep, { choice: WorkflowChoice; inherited: ModelCandidate[]; revision: string; allowedAgents: string[] }>>;
  leadModels: AgentModelStatusValue[];
}

export type WorkflowRunRow = Pick<AgentStateRow, 'key' | 'jobId' | 'taskIndex' | 'parentJobId' | 'parentTaskIndex' | 'rootThreadId' |
  'agentId' | 'label' | 'state' | 'startedAt' | 'endedAt' | 'stateReason' | 'responseModels' | 'modelStatus' | 'workflowStep' | 'followUpOf'>;

export interface WorkflowSaveInput {
  threadId: string;
  step: ProductOwnerStep;
  choice: WorkflowChoice | null;
  expectedRevision: string;
}

/** Known aliases must resolve to the vendor, including runtime display names. */
export function workflowCompany(provider: string): string | undefined {
  const name = provider.trim().toLowerCase().replace(/[ _]+/g, '-');
  if (['codex', 'openai', 'openai-codex', 'openai-api'].includes(name)) return 'openai';
  if (['claude-code', 'claude', 'anthropic', 'anthropic-api'].includes(name)) return 'anthropic';
  if (['grok', 'xai', 'x-ai', 'grok-oauth'].includes(name)) return 'grok';
  return undefined;
}
