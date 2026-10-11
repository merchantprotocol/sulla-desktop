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

  it('supports deep links, browser back, keyboard exit, loading, and errors', () => {
    expect(homeSource).toContain('route.query.issue');
    expect(homeSource).toContain('router.back()');
    expect(detailSource).toContain('@keydown.esc="$emit(\'close\')"');
    expect(detailSource).toContain('Loading issue and live review state');
    expect(detailSource).toContain('role="alert"');
  });

  it('has no human-gate approval path: the board never holds work for approval', () => {
    expect(detailSource).not.toContain('Approve and advance');
    expect(detailSource).not.toContain('humanGate');
    expect(homeSource).not.toContain('work-items:human-gate-decision');
    expect(serviceSource).not.toContain('decideProjectsHumanGate');
    expect(serviceSource).not.toContain('humanGate');
  });

  it('loads live GitHub state and never merges anything', () => {
    expect(serviceSource).toContain('octokit.pulls.get');
    expect(serviceSource).toContain('octokit.checks.listForRef');
    expect(serviceSource).toContain('octokit.pulls.listReviews');
    expect(serviceSource).toContain('documentation:');
    expect(serviceSource).toContain('testResults:');
    expect(serviceSource).not.toMatch(/pulls\.merge|github_merge_pr|mergePullRequest/);
  });
});
