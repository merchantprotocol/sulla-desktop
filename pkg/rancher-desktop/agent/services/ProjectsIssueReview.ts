export interface MergeReadinessCheck {
  status:     string;
  conclusion: string | null;
}

export interface MergeReadinessReview {
  state: string;
}

/**
 * A conservative, deterministic summary only. The UI never treats this as
 * authority to merge and a human gate remains independent of the PR head.
 */
export function evaluatePullRequestMergeReadiness(input: {
  state:     string;
  draft:     boolean;
  mergeable: boolean | null;
  checks:    MergeReadinessCheck[];
  reviews:   MergeReadinessReview[];
}): boolean {
  const successful = new Set(['success', 'neutral', 'skipped']);
  const checksReady = input.checks.length > 0 && input.checks.every(check =>
    check.status === 'completed' && successful.has(check.conclusion ?? ''));
  const reviewBlocked = input.reviews.some(review => review.state === 'CHANGES_REQUESTED');

  return input.state === 'open' && !input.draft && input.mergeable === true &&
    checksReady && !reviewBlocked;
}
