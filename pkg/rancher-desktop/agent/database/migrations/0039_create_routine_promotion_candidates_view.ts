// Routine-promotion-candidate view (issue #499, component 3: find_repeated_tasks).
//
// The `find_repeated_tasks` catalog tool is the *promotion detector* of the
// stewardship flywheel: it scans task history, clusters by a shape-signature,
// and surfaces work that has recurred often enough to be worth codifying into a
// routine (needs judgment) or a zero-token function (deterministic). The whole
// point is to push recurring work DOWN the cost ladder — expensive ad-hoc agent
// labor → routine → function — so evidence-gating (a threshold) is essential to
// avoid routine sprawl.
//
// SOURCE DECISION (settled from the live schema, correcting the earlier guess in
// #499 that tool calls live in `claude_messages.metadata.tool_calls` — there is
// NO metadata column). The only per-action log is `claude_messages` role='tool':
// one row per tool invocation whose `content` is a short human label. Shell
// actions are logged verbatim as "$ <command>", which is the richest determin-
// istic signal we have — the actual operation, with its target, per invocation.
//
// SHAPE-SIGNATURE (deterministic, no LLM):
//   - "sulla <category>/<tool>"  → the structured catalog operation (the ideal
//     promotable unit — a verbatim-repeated catalog call is exactly what should
//     become a function or a routine step).
//   - "<prog> <subcommand>" for the common multi-verb CLIs (git/npm/docker/…) so
//     "git commit" and "git log" cluster separately.
//   - else the bare program name.
//
// NOISE EXCLUSION: filesystem navigation and read-only inspection (cd/ls/grep/
// find/cat/…) are exploration, not codifiable work — excluded. Structured
// read-only catalog ops (e.g. "sulla pg/query") are KEPT: a query repeated
// verbatim across sessions is itself promotable to a view/function.
//
// THRESHOLD MEASURE: the view carries BOTH raw `occurrences` and distinct
// `conversations`. The tool gates on distinct conversations, not raw occurrences
// — the live-data lesson: a command run 32× inside ONE debugging session is not
// recurring work, whereas the same command seen across many separate sessions
// is. Raw occurrences over-counts within-session repetition; distinct
// conversations is the true recurrence measure. The view leaves the gate to the
// tool (default threshold 3) and only pre-filters singletons to stay lean.
//
// View only — additive and fully reversible (`down` drops it, no data touched).

export const up = `
  -- Promotion candidates: recurring shell/catalog operations mined from the
  -- per-action tool log, clustered by a deterministic shape-signature. Reads
  -- claude_messages (role='tool', "$ <command>" rows) over a rolling 90-day
  -- window — recent enough to be actionable, long enough to catch recurrence
  -- that spans separate work sessions.
  CREATE OR REPLACE VIEW routine_promotion_candidates AS
  WITH raw AS (
    SELECT
      conversation_id,
      created_at,
      regexp_replace(content, '^\\$ ', '') AS cmd
    FROM claude_messages
    WHERE role = 'tool'
      AND content LIKE '$ %'
      AND created_at > NOW() - INTERVAL '90 days'
  ),
  signed AS (
    SELECT
      conversation_id,
      created_at,
      CASE
        -- structured catalog op: "sulla <category>/<tool>" — the promotable unit
        WHEN cmd ~ '^sulla '
          THEN 'sulla ' || substring(cmd FROM '^sulla ([^ ]+)')
        -- program + subcommand for the common multi-verb CLIs (space-separated
        -- so "git commit" / "git log" cluster apart)
        WHEN cmd ~ '^(git|npm|pnpm|yarn|docker|kubectl|psql|gh|node|cargo|make|helm) [a-z]'
          THEN substring(cmd FROM '^([a-z]+) ')
               || ' '
               || substring(cmd FROM '^[a-z]+ ([a-z][a-z-]*)')
        -- else the bare program token
        ELSE substring(cmd FROM '^([A-Za-z0-9_./-]+)')
      END AS signature
    FROM raw
  )
  SELECT
    signature,
    COUNT(*)                             AS occurrences,
    COUNT(DISTINCT conversation_id)      AS conversations,
    MIN(created_at)                      AS first_seen,
    MAX(created_at)                      AS last_seen,
    GREATEST(0, DATE_PART('day', MAX(created_at) - MIN(created_at)))::int AS span_days
  FROM signed
  WHERE signature IS NOT NULL
    AND length(signature) > 1
    -- drop filesystem-exploration / shell-plumbing verbs: navigation and
    -- read-only inspection are noise, not codifiable work
    AND lower(split_part(signature, ' ', 1)) NOT IN (
      'cd','ls','grep','find','echo','cat','sed','awk','head','tail','wc',
      'which','for','while','until','do','done','sleep','printf','tr','sort',
      'uniq','cut','xargs','test','true','false','export','env','pwd','set',
      'read','if','then','fi','case','esac','source','.','type','stat','file',
      'basename','dirname','realpath','readlink','tee','yes','seq','date','time',
      'mkdir','touch','diff','less','more','man','clear','history'
    )
    -- drop SQL-fragment leakage: a multi-line pg query whose continuation line
    -- starts with an upper-case keyword can be logged as its own "$ " row; an
    -- all-caps single token is not a shell command
    AND signature !~ '^[A-Z]{2,}$'
  GROUP BY signature
  HAVING COUNT(*) >= 2
  ORDER BY COUNT(DISTINCT conversation_id) DESC, COUNT(*) DESC;
`;

export const down = `
  DROP VIEW IF EXISTS routine_promotion_candidates;
`;
