// Heartbeat issue-discovery seen-set (issue #500, component 3).
//
// The discovery routine (#500) scans every active repo for open issues each
// cycle. Without a durable "touched-before" record it would re-triage the same
// issue forever — burning tokens and spamming the thread. This table is that
// record: one row per issue Heartbeat has claimed, so an already-handled issue
// is filtered out cheaply (heartbeat_new_issues) and a claim is atomic across
// concurrent agents (heartbeat_claim_issue → INSERT ... ON CONFLICT DO NOTHING;
// the DB primary key is the collision guard — two agents cannot both win).
//
// Schema-only, per the no-user-data-in-migrations rule (id:nAYP): the table
// starts empty and is populated at runtime by the claim tool. Fully reversible
// (`down` drops it — no other data touched).

export const up = `
  CREATE TABLE IF NOT EXISTS heartbeat_seen_issues (
    repo_owner    TEXT        NOT NULL,
    repo_name     TEXT        NOT NULL,
    issue_number  INTEGER     NOT NULL,
    issue_node_id TEXT,
    title         TEXT,
    -- How the claim was staked on GitHub, for audit: 'assign' (self-assigned),
    -- 'label' (heartbeat label), 'comment' (triage comment), 'preexisting'
    -- (found already assigned/labeled — recorded so we never re-triage it), or
    -- 'seen' (recorded before the GitHub-side claim was applied).
    claim_method  TEXT        NOT NULL DEFAULT 'seen',
    -- Set true once the issue has been through triage → investigate → determine,
    -- so a re-scan can tell "claimed but not yet worked" from "done".
    triaged       BOOLEAN     NOT NULL DEFAULT FALSE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at    TIMESTAMPTZ,
    PRIMARY KEY (repo_owner, repo_name, issue_number)
  );

  -- Scans filter by repo, so index the repo prefix of the key.
  CREATE INDEX IF NOT EXISTS idx_heartbeat_seen_issues_repo
    ON heartbeat_seen_issues (repo_owner, repo_name);
`;

export const down = `
  DROP TABLE IF EXISTS heartbeat_seen_issues;
`;
