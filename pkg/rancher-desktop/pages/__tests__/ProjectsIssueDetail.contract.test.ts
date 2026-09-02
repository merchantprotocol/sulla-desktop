import fs from 'node:fs';

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';

const detailSource = fs.readFileSync('pkg/rancher-desktop/components/projects/ProjectIssueDetail.vue', 'utf8');
const homeSource = fs.readFileSync('pkg/rancher-desktop/pages/ProjectsHome.vue', 'utf8');
const serviceSource = fs.readFileSync('pkg/rancher-desktop/agent/services/ProjectsIssueDetailService.ts', 'utf8');

describe('full-screen Projects issue detail contract', () => {
  it('compiles as a Vue SFC and owns the full Projects context', () => {
    const { descriptor, errors } = parse(detailSource, { filename: 'ProjectIssueDetail.vue' });
    expect(errors).toEqual([]);
    expect(() => compileScript(descriptor, { id: 'project-issue-detail' })).not.toThrow();
    const template = compileTemplate({
      id: 'project-issue-detail', filename: 'ProjectIssueDetail.vue', source: descriptor.template?.content ?? '',
    });
    expect(template.errors).toEqual([]);
    expect(detailSource).toContain('position: absolute; inset: 0');
  });

  it('separates immutable description from the append-only thread and sanitizes both render paths', () => {
    expect(detailSource).toContain('Primary record');
    expect(detailSource).toContain('Immutable');
    expect(detailSource).toContain('Append-only history');
    expect(detailSource).toContain('v-html="rich(detail.task.description)"');
    expect(detailSource).toContain('v-html="rich(comment.body)"');
    expect(detailSource).toContain('renderProjectRichText');
  });

  it('supports deep links, browser back, keyboard exit, loading, errors, and explicit gate decisions', () => {
    expect(homeSource).toContain('route.query.issue');
    expect(homeSource).toContain('router.back()');
    expect(detailSource).toContain('@keydown.esc="$emit(\'close\')"');
    expect(detailSource).toContain('Loading issue and live review state');
    expect(detailSource).toContain('role="alert"');
    expect(detailSource).toContain('Approve and advance');
    expect(detailSource).toContain('Reject for repair');
    expect(detailSource).toContain('background: var(--pgreen)');
  });

  it('loads live GitHub state and never invokes merge from the decision boundary', () => {
    const decisionSource = serviceSource.slice(serviceSource.indexOf('export async function decideProjectsHumanGate'));

    expect(serviceSource).toContain('octokit.pulls.get');
    expect(serviceSource).toContain('octokit.checks.listForRef');
    expect(serviceSource).toContain('octokit.pulls.listReviews');
    expect(serviceSource).toContain('documentation:');
    expect(serviceSource).toContain('testResults:');
    expect(serviceSource).toContain('transitionTaskRelative');
    expect(serviceSource).not.toMatch(/pulls\.merge|github_merge_pr|mergePullRequest/);
    expect(serviceSource).toContain('requires_human_approval === true');
    expect(serviceSource).toContain("'Decision by: human'");
    expect(decisionSource).toContain('expectedStage');
    expect(decisionSource).not.toContain('headSha');
  });
});
