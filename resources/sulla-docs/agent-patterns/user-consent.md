# Asking the User — `ask_user_question`

Sulla can pause mid-turn to ask the human a question — pick between options,
confirm an assumption, or get an approve/deny go-ahead — before proceeding.
The `meta/ask_user_question` tool renders an interactive card in the chat
transcript and **blocks until the user answers** (or the timeout elapses).
This is the single "pause and ask the human" tool: use it for multiple-choice
questions AND for consent gates (offer `Approve` / `Deny` options). Use it
instead of charging ahead on actions the user should sign off on.

This doc is about **when** to reach for the tool and **how** to phrase the
question. Mechanics are in [`tools/meta.md`](../tools/meta.md#metaask_user_question).

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
  Give the options and let the user pick.
- You're running inside a workflow and hit a point where the user should
  sign off before the next step fires.

Don't ask when:

- The work is **read-only** (`read_file`, `file_search`, `browse_tools`,
  `function_list`, `list_project_items`). The user didn't sign up to click through
  every read.
- The user **explicitly asked for the action in their last message**. "Delete
  the draft routine `foo`" → just do it. Don't re-ask what they just told you.
- The action is **trivially reversible and local**. Creating a new draft
  routine, a new function dir, a new project — you can scrap it in one
  command if they don't like it.
- **Every turn.** If every tool call asks, the user becomes numb to the card
  and starts approving on autopilot. The gate only works if it's rare and
  meaningful.

---

## How to phrase the question

Each question renders a `question` headline, an optional `header` chip, and
2–4 selectable `options` (each `{ label, description? }`). All of it is
user-facing — write it for a human, not for yourself.

### `question` — the headline

- **One line.** Anything longer gets lost.
- **Neutral summary, not a loaded yes/no.** "Delete the draft routine
  `blog-publisher-v2`?" — the user infers Approve = yes, Deny = no without
  you editorializing.
- **Name the concrete thing.** "Delete 3 draft routines" is better than
  "Clean up drafts". Use the real slug / id / filename.
- **Include the irreversible bit.** A publish should say "Publish
  `routine:blog-publisher` v1.2.0 to the **public** marketplace" — the
  "public" matters.

### `options` — the choices

- **For a consent gate, offer `Approve` / `Deny`.** Put the exact action /
  command / payload in the `Approve` option's `description` so the user sees
  precisely what they're greenlighting — e.g.
  `{ "label": "Approve", "description": "rm -rf ~/sulla/routines/blog-publisher-v2" }`.
- **For a fork, make the options the real paths.** "Overwrite" vs "Save as
  new version" vs "Cancel" — each label a concrete action, not "Yes/No".
- **Don't hide behind abstraction.** `rm -rf ~/sulla/routines/foo` in a
  description is more informative than "remove the routine directory." The
  user can read.
- **2–4 options, distinct.** More than that and the card gets noisy.

### Good / bad examples

| Bad question | Good question |
|--------------|---------------|
| "Is it OK if I delete this?" | "Delete function `csv-to-json` (and its 3 version history rows)?" → Approve / Deny |
| "Proceed?" | "Publish `routine:hello-world` v1 to the marketplace?" → Approve / Deny |
| "Need your input" | "Existing `routine.yaml` found — overwrite or save as a new version?" → Overwrite / Save new / Cancel |
| "Do you want me to do this?" | "Send Slack message to #sales about the Hagadone lead?" → Approve / Deny |

---

## After the answer

The tool returns a summary of the option(s) the user selected (or a
"no selection / timed out" note).

- **Picked `Approve` (or a concrete path):** proceed with the action.
  Reference the choice in your follow-up ("Approved — deleting now.") so the
  user sees continuity.
- **Picked `Deny`:** stop, acknowledge, and ask what they'd prefer. Don't
  argue or re-ask the same question with different wording.
- **No selection / timed out:** treat as a soft deny. The user probably
  stepped away. Don't proceed. Say what you would have done and wait for the
  next turn.

**Denial doesn't mean abandon the whole task.** If denial closes one path
(e.g. "don't push to main"), consider whether an alternative path is
valid ("push to a branch and open a PR instead?") and offer it.

---

## `ask_user_question` vs `<AGENT_BLOCKED>` wrapper

Both get the user involved, but they're for different moments.

| | `ask_user_question` | `<AGENT_BLOCKED>` wrapper |
|-|---------------------|--------------------------|
| **When** | Mid-turn — you're executing and need a pick or a go/no-go before the next step | End-of-turn — you cannot proceed at all without a larger decision or missing input |
| **Continuation** | You keep working in the same response after the user answers | Turn ends. User's next message starts a new turn. |
| **Shape** | 2–4 selectable options (incl. Approve/Deny); user may also type free-form | Free-form question for the user to answer |
| **Use for** | "Should I delete this one file?" · "Overwrite or save as new version?" | "I need your AWS credentials to continue — where should I look?" |

If the decision is a bounded pick or a go/no-go and you want to finish the
user's request in the current turn → `ask_user_question`.

If you genuinely can't go further without a bigger conversation or missing
input → end the turn with `<AGENT_BLOCKED>`.

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

- Tool (in-process): `pkg/rancher-desktop/agent/tools/meta/ask_user_question.ts`
- Tool (Claude Code MCP bridge): `mcp__sulla-native__ask_user_question` (see `main/MCPServerHost.ts`)
- Shared helpers: `pkg/rancher-desktop/agent/tools/meta/askUserQuestionShared.ts`
- Service: `pkg/rancher-desktop/agent/services/ApprovalService.ts` (`parkQuestion`)
- IPC: the renderer fires `question:resolve` back to main to settle the pending promise
- Frontend card: `pages/chat/components/tool/ToolQuestion.vue`
- Frontend wiring: `pages/chat/services/PersonaAdapter.ts` (question bridge)
