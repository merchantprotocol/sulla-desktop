# Asking for User Consent — `request_user_input`

Sulla can pause mid-turn to ask the human for an approve/deny decision before
proceeding. The `meta/request_user_input` tool renders an inline approval card
in the chat transcript and **blocks until the user clicks a button** (or the
timeout elapses). This is the canonical consent gate — use it instead of
charging ahead on actions the user should sign off on.

This doc is about **when** to reach for the tool and **how** to phrase the
question. Mechanics are in [`tools/meta.md`](../tools/meta.md#metarequest_user_input).

---

## When to ask

Always ask when the action is:

- **Destructive and hard to undo.** Deleting a file, routine, function, recipe,
  credential, DB row, git branch. `rm -rf`. `git push --force`. Dropping a
  table.
- **Outbound to third parties.** Sending an email (Gmail), a Slack/Discord
  message, a CRM write, a calendar invite to someone else, a GitHub issue or
  PR comment. Anything the user can't quietly undo without the other side
  noticing.
- **Publishing or shipping.** `marketplace/publish`, flipping a workflow to
  `status: "production"`, creating a TestFlight build, a `git push` to a
  protected branch.
- **Paying money or triggering spend.** Any tool that hits a paid API with
  usage-based billing if the call is unusually large or iterative.

Ask when ambiguous:

- The user's request has a clear destructive step but they didn't spell out
  approval ("clean up all the draft routines"). Ask before the first delete
  even if they implied the whole set.
- Multiple valid interpretations exist and picking one locks in a path
  (overwrite vs rename, merge vs rebase, save draft vs save production).
  Ask the user to pick.
- You're running inside a workflow and hit a point where the user should
  sign off before the next step fires.

Don't ask when:

- The work is **read-only** (`read_file`, `file_search`, `browse_tools`,
  function_list, memory recall). The user didn't sign up to click through
  every read.
- The user **explicitly asked for the action in their last message**. "Delete
  the draft routine `foo`" → just do it. Don't re-ask what they just told you.
- The action is **trivially reversible and local**. Creating a new draft
  routine, a new function dir, a new project — you can scrap it in one
  command if they don't like it.
- **Every turn.** If every tool call asks for approval, the user becomes
  numb to the card and starts approving on autopilot. The gate only works if
  it's rare and meaningful.

---

## How to phrase the question

The card renders two strings prominently: the `question` (card headline)
and the `command` (mono-font block below). Both are user-facing — write
them for a human, not for yourself.

### `question` — the headline

- **One line.** Anything longer gets lost.
- **Neutral summary, not a loaded yes/no.** "Delete the draft routine
  `blog-publisher-v2`?" — the user infers approve = yes, deny = no without
  you editorializing.
- **Name the concrete thing.** "Delete 3 draft routines" is better than
  "Clean up drafts". Use the real slug / id / filename.
- **Include the irreversible bit.** "Publish to the marketplace" should say
  "Publish `routine:blog-publisher` v1.2.0 to the public marketplace" — the
  "public" matters.

### `command` — the exact action

- **Show the actual payload** you're about to run. If it's a `sulla` call,
  paste the exact `sulla cat/tool '{...}'` line.
- **Don't hide behind abstraction.** `rm -rf ~/sulla/routines/foo` is more
  informative than "remove the routine directory." The user can read.
- **Omit when obvious.** If the question is "Save memory: 'user prefers
  serif fonts'?", you don't need a separate `command`. Both fields cost
  screen space.

### Good / bad examples

| Bad question | Good question |
|--------------|---------------|
| "Is it OK if I delete this?" | "Delete function `csv-to-json` (and its 3 version history rows)?" |
| "Proceed?" | "Publish `routine:hello-world` v1 to the marketplace?" |
| "Need your input" | "Overwrite existing `~/sulla/routines/blog-publisher/routine.yaml`?" |
| "Do you want me to do this?" | "Send Slack message to #sales about the Hagadone lead?" |

---

## After the decision

The tool returns `{ decision: "approved" | "denied" | "timed_out", note? }`.

- **Approved:** proceed with the action. Reference the approval in your
  follow-up (e.g. "Approved — deleting now.") so the user sees continuity.
- **Denied:** stop, acknowledge, and ask what they'd prefer. Don't argue
  or re-ask the same question with different wording.
- **Timed out:** treat as a soft deny. The user probably stepped away.
  Don't proceed. Say what you would have done and wait for the next turn.

**Denial doesn't mean abandon the whole task.** If denial closes one path
(e.g. "don't push to main"), consider whether an alternative path is
valid ("push to a branch and open a PR instead?") and offer it.

---

## `request_user_input` vs `<AGENT_BLOCKED>` wrapper

Both get the user involved, but they're for different moments.

| | `request_user_input` | `<AGENT_BLOCKED>` wrapper |
|-|---------------------|--------------------------|
| **When** | Mid-turn — you're executing and need a single go/no-go before the next step | End-of-turn — you cannot proceed at all without a larger decision or missing input |
| **Continuation** | You keep working in the same response after the user decides | Turn ends. User's next message starts a new turn. |
| **Shape** | Binary approve/deny | Free-form question for the user to answer |
| **Use for** | "Should I delete this one file?" | "Which of these three APIs should we integrate with?" |
| **Use for** | "OK to send this draft email as-is?" | "I need your AWS credentials to continue — where should I look?" |

If the decision is binary, action-specific, and you want to finish the
user's request in the current turn → `request_user_input`.

If you genuinely can't go further without a bigger conversation → end the
turn with `<AGENT_BLOCKED>`.

---

## Hard rules

- **Never fake approval.** Don't assume yes because the user has approved
  similar things before. Every gated action gets its own card.
- **Never skip the card for destructive/outbound work** to "save the user
  a click." The 5-second click is the point.
- **Keep the card accurate.** If you change the action between emitting
  the card and executing, re-ask. The card is a contract.
- **Don't spam.** Bundle related approvals when possible ("delete 3
  routines: foo, bar, baz?" — one card, three deletes). Never three cards
  in a row for the same batch.

---

## Reference

- Tool: `pkg/rancher-desktop/agent/tools/meta/request_user_input.ts`
- Service: `pkg/rancher-desktop/agent/services/ApprovalService.ts`
- IPC: `main/sullaApprovalEvents.ts` (`approval:resolve`)
- Frontend card: `pages/chat/components/tool/ToolApproval.vue`
- Frontend wiring: `pages/chat/services/PersonaAdapter.ts` (approval bridge)
