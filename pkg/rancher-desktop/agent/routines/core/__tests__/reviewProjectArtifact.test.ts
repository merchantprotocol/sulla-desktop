import { describe, expect, it } from '@jest/globals';

import { validateWorkflowDefinition } from '../../../tools/workflow/validate_sulla_workflow';
import { CORE_ROUTINES } from '../index';
import { DEFAULT_CORE_ROUTINE_AGENT_ID } from '../defaultCoreAgent';
import {
  REVIEW_PROJECT_ARTIFACT_DEFINITION,
  REVIEW_PROJECT_ARTIFACT_ID,
  ARTIFACT_VERIFICATION_ADAPTERS,
  REVIEWER_NODE_IDS,
} from '../reviewProjectArtifact';

describe('protected review core routine', () => {
  it('is a visible seeded graph with independent reviewers and a separate synthesis step', () => {
    expect(REVIEW_PROJECT_ARTIFACT_DEFINITION.id).toBe(REVIEW_PROJECT_ARTIFACT_ID);
    expect(CORE_ROUTINES).toContain(REVIEW_PROJECT_ARTIFACT_DEFINITION);
    expect(REVIEW_PROJECT_ARTIFACT_DEFINITION.enabled).toBe(true);
    const nodes = REVIEW_PROJECT_ARTIFACT_DEFINITION.nodes;
    const reviewers = nodes.filter((node: any) => (REVIEWER_NODE_IDS as readonly string[]).includes(node.id));
    expect(reviewers.every((node: any) => node.data.config.agentId === DEFAULT_CORE_ROUTINE_AGENT_ID)).toBe(true);
    expect(reviewers.every((node: any) => node.data.config.inheritParentToolPolicy === true)).toBe(true);
    expect(nodes.filter((node: any) => node.data.subtype === 'agent')
      .every((node: any) => node.data.config.inheritParentToolPolicy === true)).toBe(true);
    expect(nodes.find((node: any) => node.id === 'node-review-synthesize')?.data.config.agentId)
      .toBe(DEFAULT_CORE_ROUTINE_AGENT_ID);
    expect(REVIEW_PROJECT_ARTIFACT_DEFINITION.edges.filter((edge: any) => edge.target === 'node-review-merge')).toHaveLength(3);
  });

  it('names every deterministic disposition and forbids authority-crossing actions', () => {
    const serialized = JSON.stringify(REVIEW_PROJECT_ARTIFACT_DEFINITION);
    for (const disposition of ['PASS', 'REPAIRABLE', 'REPLAN', 'EXTERNAL_WAIT', 'BLOCKED']) {
      expect(serialized).toContain(disposition);
    }
    expect(serialized).toContain('Never edit files or records');
    expect(serialized).toContain('Never treat unpublished outbound work as sent');
    expect(serialized).toContain('full head SHA');
  });

  it('passes the canonical workflow graph validator', () => {
    const issues = validateWorkflowDefinition(REVIEW_PROJECT_ARTIFACT_DEFINITION);
    expect(issues.filter(issue => issue.severity === 'error')).toEqual([]);
  });

  it('selects explicit read-only adapters for every non-code artifact class', () => {
    for (const type of ['documentation', 'marketing_campaign', 'research', 'data_spreadsheet', 'design_media', 'operations_configuration', 'projects_evidence'] as const) {
      expect(ARTIFACT_VERIFICATION_ADAPTERS[type].adapter).toBeTruthy();
      expect(ARTIFACT_VERIFICATION_ADAPTERS[type].tools.length).toBeGreaterThan(0);
    }
    expect(ARTIFACT_VERIFICATION_ADAPTERS.marketing_campaign.tools).toContain('get_project_item');
    expect(ARTIFACT_VERIFICATION_ADAPTERS.data_spreadsheet.tools).toContain('snapshot');
    expect(ARTIFACT_VERIFICATION_ADAPTERS.operations_configuration.tools).toContain('calendar_get');
  });
});
