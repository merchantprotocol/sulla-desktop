import { evaluatePullRequestMergeReadiness } from '../ProjectsIssueReview';

const successCheck = { name: 'build', status: 'completed', conclusion: 'success', url: null };

describe('Projects issue review readiness', () => {
  it('requires an open non-draft mergeable PR with completed successful checks', () => {
    expect(evaluatePullRequestMergeReadiness({
      state: 'open', draft: false, mergeable: true, checks: [successCheck], reviews: [],
    })).toBe(true);
    expect(evaluatePullRequestMergeReadiness({
      state: 'open', draft: true, mergeable: true, checks: [successCheck], reviews: [],
    })).toBe(false);
    expect(evaluatePullRequestMergeReadiness({
      state: 'open', draft: false, mergeable: true, checks: [], reviews: [],
    })).toBe(false);
  });

  it('fails closed for pending checks and requested changes', () => {
    expect(evaluatePullRequestMergeReadiness({
      state:     'open',
      draft:     false,
      mergeable: true,
      checks:    [{ ...successCheck, status: 'in_progress', conclusion: null }],
      reviews:   [],
    })).toBe(false);
    expect(evaluatePullRequestMergeReadiness({
      state:     'open',
      draft:     false,
      mergeable: true,
      checks:    [successCheck],
      reviews:   [{ state: 'CHANGES_REQUESTED' }],
    })).toBe(false);
  });
});
