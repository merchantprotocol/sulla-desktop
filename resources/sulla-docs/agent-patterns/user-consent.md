# Asking the User — `ask_user_question`

Sulla can pause mid-turn to ask the human a question: pick between options, or confirm a destructive or outbound action. The `meta/ask_user_question` tool renders an interactive card in the chat transcript and **blocks until the user answers** (or the timeout elapses). Use it for multiple-choice questions, and for consent gates on destructive or outbound actions (offer `Approve` / `Deny` options).

This doc is about **when** to reach for the tool and **how** to phrase the question. Mechanics are in [`tools/meta.md`](../tools/meta.md#metaask_user_question).

Merges, deploys, pushes to branches, and status changes like "make this workflow production" aren't gated. Decide them yourself. Use the safeguards the playbook already sets: validation, dry runs, backups, and a reversible rollout. Then report what you did.

---

## When to ask

Ask before the action when it's:

- **Destructive and hard to undo.** Deleting a file, routine, function, recipe, credential, DB row, or git branch. `rm -rf`. `git push --force`. Dropping a table. Anything that loses data.
- **Outbound, as a message in the user's name.** Sending an email, a Slack or Discord message, a CRM write, a calendar invite to someone else, or a GitHub issue or PR comment. Anything the user can't quietly undo without the other side noticing.
- **Paying money or triggering spend.** Any tool that bills the user's account, especially if the call is unusually large or iterative. The card is his.
- **Something only the user can do.** His own logins and 2FA, his legal signatures, and anything that needs his accounts in his name.

Ask when the choice is ambiguous and the wrong pick can't be undone:

- The user's request has a destructive step, but they didn't spell out approval ("clean up all the draft routines"). Ask before the first delete, even if they implied the whole set.
- Two valid interpretations lead to a path you can't walk back. Overwrite vs rename, or delete vs archive. Give the options and let the user pick.

If the choice is reversible, pick the best option, do it, and say which one you picked. Don't ask.

Don't ask when:

- The work is **read-only** (`read_file`, `file_search`, `browse_tools`, `function/list`, `project/list_project_items`). The user didn't sign up to click through every read.
- The user **explicitly asked for the action in their last message**. "Delete the draft routine `foo`" means just do it. Don't re-ask what they just told you.
- The action is **trivially reversible and local**. Creating a new draft routine, a new function dir, or a new project. You can scrap it in one command.
- **Every turn.** If every tool call asks, the user goes numb to the card and starts approving on autopilot. The gate only works if it's rare and meaningful.

---

## How to phrase the question

Each question renders a `question` headline, an optional `header` chip, and 2–4 selectable `options` (each `{ label, description? }`). All of it is user-facing. Write it for a human, not for yourself.

### `question` — the headline

- **One line.** Anything longer gets lost.
- **Neutral summary, not a loaded yes/no.** "Delete the draft routine `blog-publisher-v2`?" The user infers Approve means yes and Deny means no, without you editorializing.
- **Name the concrete thing.** "Delete 3 draft routines" is better than "Clean up drafts". Use the real slug, id, or filename.
- **Include the irreversible bit.** "Delete function `csv-to-json` and its 3 version history rows?" The data loss is the point.

### `options` — the choices

- **For a consent gate, offer `Approve` / `Deny`.** Put the exact action, command, or payload in the `Approve` option's `description`, so the user sees precisely what they're approving. For example: `{ "label": "Approve", "description": "rm -rf ~/sulla/routines/blog-publisher-v2" }`.
- **For a fork, make the options the real paths.** "Overwrite" vs "Save as new version" vs "Cancel". Each label is a concrete action, not "Yes/No".
- **Don't hide behind abstraction.** `rm -rf ~/sulla/routines/foo` in a description tells the user more than "remove the routine directory". They can read it.
- **2–4 options, distinct.** More than that and the card gets noisy.

### Good / bad examples

| Bad question | Good question |
|--------------|---------------|
| "Is it OK if I delete this?" | "Delete function `csv-to-json` (and its 3 version history rows)?" → Approve / Deny |
| "Proceed?" | "Send a Slack message to #sales about the new lead?" → Approve / Deny |
| "Need your input" | "Existing `routine.yaml` found — overwrite or save as a new version?" → Overwrite / Save new / Cancel |
| "Do you want me to do this?" | "Email the customer a follow-up from your account?" → Approve / Deny |

---

## After the answer

The tool returns a summary of the option the user picked, or a "no selection / timed out" note.

- **Picked `Approve` (or a concrete path):** proceed with the action. Say the choice in your follow-up ("Approved — deleting now.") so the user sees continuity.
- **Picked `Deny`:** stop, acknowledge it, and ask what they'd prefer. Don't argue or re-ask the same question in different words.
- **No selection / timed out:** treat it as a soft deny. The user probably stepped away. Don't proceed. Say what you would have done, and wait for the next turn.

**Denial doesn't mean abandon the whole task.** If the denial closes one path ("don't delete it"), check whether an alternative is valid ("archive it instead?") and offer that.

---

## `ask_user_question` vs `<AGENT_BLOCKED>` wrapper

Both get the user involved, but for different moments.

| | `ask_user_question` | `<AGENT_BLOCKED>` wrapper |
|-|---------------------|--------------------------|
| **When** | Mid-turn. You're executing and need a pick or a go/no-go before a destructive or outbound step | End of turn. You can't proceed at all without a bigger decision or missing input |
| **Continuation** | You keep working in the same response after the user answers | The turn ends. The user's next message starts a new turn |
| **Shape** | 2–4 selectable options (including Approve/Deny). The user may also type a free-form answer | A free-form question for the user to answer |
| **Use for** | "Delete this one file?" · "Overwrite or save as a new version?" | "I need your AWS credentials to continue. Where should I look?" |

If the decision is a bounded pick or a go/no-go on a destructive or outbound step, and you want to finish in the current turn, use `ask_user_question`.

If you genuinely can't go further without a bigger conversation or missing input, end the turn with `<AGENT_BLOCKED>`.

---

## Hard rules

- **Never fake approval.** Don't assume yes because the user approved something similar before. Every gated action gets its own card.
- **Never skip the card for destructive or outbound work** to save the user a click. The click is the point.
- **Keep the card accurate.** If you change the action between showing the card and running it, ask again. The card is a contract.
- **Don't spam.** Bundle related approvals when you can ("delete 3 routines: foo, bar, baz?", one card, three deletes). Never three cards in a row for the same batch.

---

## Reference

- Tool (in-process): `pkg/rancher-desktop/agent/tools/meta/ask_user_question.ts`
- Tool (Claude Code MCP bridge): `mcp__sulla-native__ask_user_question` (see `main/MCPServerHost.ts`)
- Shared helpers: `pkg/rancher-desktop/agent/tools/meta/askUserQuestionShared.ts`
- Service: `pkg/rancher-desktop/agent/services/ApprovalService.ts` (`parkQuestion`)
- IPC: the renderer fires `question:resolve` back to main to settle the pending promise (unverified)
- Frontend card: `pages/chat/components/tool/ToolQuestion.vue`
- Frontend wiring: `pages/chat/services/PersonaAdapter.ts` (question bridge)
