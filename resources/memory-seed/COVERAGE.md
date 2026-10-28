# Memory seed coverage

This file grades the seed pack against the jobs Sulla agents actually get asked to do.
It is not a subject or a skill. The seeder reads only `subjects/` and `skills/`, so it ignores this file.

The use cases live in `scripts/memory-seed-eval/use-cases.json`. Each one has a request as a
person would type it, its area, the subjects and skills in this pack that should answer it, and a grade.
That file has the same shape as `cues.json` plus `area` and `coverage`. Gap rows leave subjects and skills empty.

## How the list was built

- The tool surface: every category in `pkg/sulla-desktop/agent/tools/*/manifests.ts`.
- The built-in agents (`agent/builtinAgents/builtin-agents.json`) and the live agent directory.
- The retired user-stories reference.
- The repo `examples/` folder (extensions and use cases).
- Real requests from long-running installs, read only to learn what kinds of jobs people ask for.
  Every row is written generically. No names, companies, projects, links or numbers came across.

## Grades

- **covered**: a skill in this pack teaches the job end to end.
- **partial**: the pack has the facts or the tools, but no skill walks through the job.
- **gap**: nothing in the pack helps.

| Grade | Count |
|---|---|
| covered | 82 |
| partial | 63 |
| gap | 54 |
| **total** | **199** |

| Area | Use cases | Covered | Partial | Gap |
|---|---|---|---|---|
| Conversation and replies | 8 | 7 | 1 | 0 |
| Research and the web | 11 | 3 | 2 | 6 |
| Writing, marketing and content | 10 | 1 | 3 | 6 |
| Design and mockups | 6 | 0 | 4 | 2 |
| Coding and GitHub | 18 | 6 | 8 | 4 |
| Deploy and hosting | 8 | 1 | 2 | 5 |
| Testing and QA | 5 | 3 | 2 | 0 |
| Sub-agents and delegation (being improved) | 9 | 8 | 1 | 0 |
| Goals and projects (being improved) | 5 | 2 | 3 | 0 |
| Files and documents (being improved) | 9 | 6 | 3 | 0 |
| Memory, rules and identity | 8 | 7 | 1 | 0 |
| Workflows, functions and automation (being improved) | 11 | 7 | 4 | 0 |
| Heartbeat and background work (being improved) | 6 | 3 | 3 | 0 |
| Marketplace and extensions (being improved) | 7 | 6 | 1 | 0 |
| Integrations and credentials | 10 | 2 | 4 | 4 |
| Email and messaging | 7 | 2 | 1 | 4 |
| Calendar, reminders and notifications | 7 | 3 | 2 | 2 |
| Data and analytics | 6 | 1 | 3 | 2 |
| System health, Docker and the VM | 11 | 3 | 4 | 4 |
| Sulla Desktop app and settings | 9 | 5 | 3 | 1 |
| Mac and host control | 5 | 1 | 2 | 2 |
| Capture, voice and meetings | 7 | 4 | 1 | 2 |
| Mobile and Cloud | 4 | 1 | 2 | 1 |
| Business operations | 8 | 0 | 2 | 6 |
| Devices, networks and IT | 4 | 0 | 1 | 3 |

**Being improved.** Sub-agents, heartbeat and Playbooks, Files stewardship (projects included),
marketplace, and workflows, functions and agent loops all have writers working on them right now.
They are graded against what is on this branch. The gap list below does not propose skills for them.

**The pattern.** The pack is strong where Sulla documents itself: its own tools, memory, files,
agents and workflows. It is weak on the everyday jobs people bring: research, writing and
marketing, shipping code in their own repos, deploying, email, calling connected services,
and getting back on track after a restart. Most of those jobs use tools that already exist.
What's missing is the steps.

## Gaps, ranked by how often people will need them

Each entry: proposed slug, scope, the tools or code it relies on (checked against the manifests on
this branch), and the use cases it would close. CLI names drop the `<category>_` prefix
(`github_git_status` is `sulla github/git_status`). Integration calls go through the vault proxy,
`sulla <account_id>/<slug> '<json>'`, or MCP, `sulla <account_id>/mcp/<tool> '<json>'`. Find the
account ids with `sulla vault/list_accounts '{}'`.

1. **`sulla-resume-after-restart`**: after the app restarts or crashes, check health, find the work that was cut off, and resume it.
   Relies on: `sulla agents/check_agent_jobs`, `sulla docker/ps`, `sulla docker/logs`, `sulla pg/queryone`, `sulla models/providers`, `sulla github/git_status`, `sulla github/list_prs`, `sulla files/search` (for each project's TASKS.md).
   Closes: "I just restarted, run some diagnostics", "we crashed, pick up where you left off", "did everything from last night get in?", "check Postgres before doing anything else".
2. **`sulla-ship-a-code-change`**: change code in any repo end to end. Clone or add a worktree, branch, edit, read a build error log, commit, push, open a draft PR, read CI, clean up. `sulla-change-sulla-source` covers only Sulla's own source.
   Relies on: `sulla github/git_worktree`, `github/git_branch`, `github/git_add`, `github/git_commit`, `github/git_push`, `github/create_pr`, `github/ready_pr`, `github/check_runs`, `github/ci_logs`, `sulla meta/exec`.
   Closes: "fix this bug in my repo and open a PR", "I got a build error, here's the log", "CI is red, find out why and fix it", "add this feature to my app".
3. **`sulla-review-and-merge-prs`**: review a PR, check CI and reviews, resolve conflicts, merge in a safe order, and confirm the base branch is healthy.
   Relies on: `sulla github/list_prs`, `github/get_pr`, `github/get_pr_files`, `github/list_pr_reviews`, `github/add_pr_review`, `github/git_conflicts`, `github/check_runs`, `github/merge_pr`, `github/create_release`.
   Closes: "review this pull request", "merge all the PRs that are ready", "resolve the merge conflicts", "bring every PR that should ship into one release", "cut a release and write the notes".
4. **`sulla-research-and-write-brief`**: research a question on the web, check the sources against each other, cache what you learned, and save a cited brief to Files.
   Relies on: `sulla browser/background_browse`, `browser/text`, `sulla memory/recall_index_lookup`, `memory/recall_index_store`, `sulla files/where`, `files/search`; the `sulla-cite-sources` and `sulla-save-work-in-files` skills.
   Closes: competitor research, "how does this company get customers", "most popular tools and why", "find reliable research", "is this business idea worth it?".
5. **`sulla-use-an-integration`**: connect a service, test that the key works, then call its API or MCP tools without exposing the secret. Includes OAuth failures and making a token with the right scopes.
   Relies on: `sulla ui/open_tab '{"mode":"integrations"}'`, `sulla vault/list_accounts`, `vault/is_enabled`, `vault/set_active_account`, the proxy and MCP call forms above; the native integration catalog in `agent/integrations/native/`.
   Closes: "connect my GitHub account", "I put the API key in the vault, test it", "pull the open deals from my CRM", "create a customer in our billing system", "walk me through making an API token", "the OAuth sign-in fails".
6. **`sulla-show-mockups`**: make several static HTML design options in the human's own brand, serve them, open them for review, and record the pick before anyone builds.
   Relies on: the built-in `mockup-designer` agent via `sulla meta/spawn_agent`, `sulla files/where`, `sulla docker/run` (its `options` field carries port and volume flags), `sulla browser/tab`. Check the serving path from the VM to the browser before writing the steps.
   Closes: "show me three mockups", "ten hero variations", "restyle this to match our brand", "open the mockup in my browser", "build option two into the real app".
7. **`sulla-deploy-a-site`**: deploy a website or app, protect a staging site, set up deploy-on-merge, and prove it is live.
   Relies on: `sulla github/trigger_workflow_run` (needs `workflow_dispatch`), `github/check_runs`, `github/ci_logs`, hosting integrations through the proxy (`cloudflare`, `vercel`, `netlify`, `render`, `fly_io` are in the catalog), `sulla browser/tab` and `browser/monitor_network` to verify.
   Closes: "deploy this website", "get this out to staging", "is this live yet?", "put this site behind a password", "set up a GitHub Action that deploys", "point my domain at it".
8. **`sulla-test-a-web-app`**: test a web app in Sulla's browser against user stories, catch failed requests, take screenshots, and report issues in a fixed shape. Playbooks are being improved separately; this skill should cover only browser testing and link to that work.
   Relies on: `sulla browser/tab`, `browser/snapshot`, `browser/click`, `browser/fill`, `browser/screenshot`, `browser/monitor_network` (`watch_errors`), `sulla vault/autofill` for logins, the built-in `ui-test-manager` agent with the `ui-test-issues` return contract.
   Closes: "test the whole app in the browser and fix what's broken", "log in to staging and walk through signup".
9. **`sulla-handle-email`**: triage an inbox, draft replies, and send in batches. Sending waits for the human's go-ahead.
   Relies on: email integrations through the proxy (`gmail`, `microsoft_outlook`, `smtp`, `sendgrid_email`, `resend`, `postmark` are in the catalog), `sulla meta/ask_user_question` for the send gate, `sulla applescript/execute` as the Mac Mail fallback.
   Closes: "draft a reply to this customer email", "go through my inbox", "send these emails five at a time", "send that through Mail on my Mac".
10. **`sulla-run-an-app-locally`**: build and run an app or dev stack in a container, seed it with test data, open it, and stop it cleanly.
    Relies on: `sulla docker/build`, `docker/run`, `docker/logs`, `docker/exec`, `docker/stop`, `sulla browser/tab`.
    Closes: "build and run this app in a container", "bring the local dev stack back up with test data", "serve these HTML files from a container".
11. **`sulla-plan-and-make-content`**: write social posts, a content calendar, a marketing plan or an SEO check from real customer language. Save drafts to Files. Post only after the human approves.
    Relies on: `sulla-write-for-a-human`, `sulla browser/background_browse` for research, `sulla files/where`, social integrations through the proxy (`buffer`, `linkedin`, `instagram`, `youtube` and others are in the catalog), `sulla meta/ask_user_question`.
    Closes: "draft a week of social posts", "plan a content calendar", "give me a marketing plan", "check this page for SEO mistakes", "write the homepage copy".
12. **`sulla-collect-web-data`**: pull structured data from websites into a CSV or table, then make it repeatable.
    Relies on: `sulla browser/background_browse`, `browser/text`, `browser/eval_js`, `sulla function/run` for a reusable scraper, `sulla-build-workflow` to schedule it, `sulla files/where` or `sulla pg/execute` for the output.
    Closes: "pull all the listings into a spreadsheet", "build a lead list from public directories".
13. **`sulla-analyze-data`**: load a spreadsheet, database table or connected source, compute the answer, and reply with a chart and provenance.
    Relies on: `sulla files/search`, `sulla gdrive/download`, `sulla pg/queryall`, `sulla function/run` (Python runtime), `sulla-reply-with-rich-html`, the built-in `analytics-worker` agent.
    Closes: "analyze this spreadsheet", "monthly report of what we did for this client", "how many signups this week?", "build me a dashboard".
14. **`sulla-remind-and-follow-up`**: choose the right timer for a reminder or follow-up and confirm it is armed.
    Relies on: `sulla browser/schedule_alarm` (one-shot, does not survive restarts), `sulla calendar/create`, a scheduled workflow via `sulla-schedule-or-trigger-workflow`, `sulla notify/user`.
    Closes: "remind me in 10 minutes", "remind me every Monday", "plan my week around these commitments", "prep me for this week's meetings".
15. **`sulla-automate-a-business-routine`**: turn a recurring business chore into a draft-then-approve routine (reviews, check-ins, receipts, leads, renewals, orders).
    Relies on: `sulla-build-workflow`, `sulla-use-an-integration` (proposed above), `sulla meta/ask_user_question`. The repo's `examples/use-cases/` folders (expense receipts, lead capture, churn check-ins, review replies, invoice reminders, contract renewals) are good templates for the skill writer. They do not ship to installs.
    Closes: "log this expense receipt", "capture leads into the CRM", "draft responses to our new reviews", "draft check-ins for quiet customers", "track which contracts renew soon", "help me figure out what to order".
16. **`sulla-report-an-app-problem`**: when the Desktop app itself shows an error, capture it, check whether an update fixes it, and file a clean issue.
    Relies on: `sulla capture/screenshot`, `sulla-handle-desktop-updates`, `sulla docker/logs`, `sulla github/create_issue`.
    Closes: "the app shows an error when I attach a file".
17. **`sulla-choose-models-and-watch-costs`**: pick or change models for chat and agents, and explain where usage and cost come from.
    Relies on: `sulla models/providers`, `models/list`, `models/usage`, `sulla settings/get`, `settings/set`, `sulla ui/open_tab '{"mode":"models"}'`.
    Closes: "change the default model", "why are my AI costs climbing?", "run this agent with a different model".
18. **`sulla-make-images-and-video`**: generate an image for a post, or plan and produce a short video, and save it to Files.
    Relies on: image and media integrations through the proxy (`stability_ai`, `replicate`, `openai`, `elevenlabs` are in the catalog), `sulla-record-with-capture-studio` for screen-recorded demos, `sulla files/where`.
    Closes: "make me an image for this post", "make a short explainer video".
19. **`sulla-check-system-resources`**: find what is using memory or CPU in the VM, on containers or on the host, and fix it safely.
    Relies on: `sulla meta/exec`, `sulla docker/ps`, `docker/stop`, `sulla meta/exechost` (only when host access is on).
    Closes: "something is eating memory", "a container keeps getting killed", "how is the VM running?".
20. **`sulla-connect-phone-and-cloud`**: pair Sulla Mobile, check the link, troubleshoot a phone that won't connect, and explain what Cloud adds.
    Relies on: `sulla mobile/list_devices`, `sulla notify/user` with the `mobile` target as a live test, the `sulla-mobile` and `sulla-cloud` subjects.
    Closes: "how do I pair my phone?", "my phone won't connect", "can I see my desktop chats from the cloud?".
21. **`sulla-transcribe-and-voice`**: transcribe a past recording, and fix a mic or voice mode that hears nothing.
    Relies on: `sulla capture/audio_state`, `capture/mic_start`, `capture/mic_stop`, `sulla ui/open_tab '{"mode":"audio"}'`, speech-to-text integrations through the proxy (`deepgram`, `assemblyai`).
    Closes: "transcribe this old recording", "voice mode didn't pick anything up".
22. **`sulla-control-mac-apps`**: tested AppleScript recipes for Reminders, Calendar, Notes, Finder, Music and appearance, plus how to read the audit log.
    Relies on: `sulla applescript/execute`, `applescript/audit_log`, `sulla-host-vs-vm`.
    Closes: "add this to my Reminders app", "open this folder in Finder" (both partial today).
23. **`sulla-build-a-browser-extension`**: build, load, test and package a browser extension, and prepare a store listing. Uploading waits for the human.
    Relies on: `sulla-ship-a-code-change` (proposed above), `sulla meta/exec` to package, `sulla browser/tab` to test.
    Closes: "build a Chrome extension from this mockup", "package the extension and update the store listing".
24. **`sulla-inventory-the-network`**: list devices on the local network and check one device, with the human's consent.
    Relies on: `sulla meta/exec` or a scanner container via `sulla docker/run`. Confirm what the VM network can reach before writing the steps.
    Closes: "what devices are on my network?", "help me get into this old server".
25. **Extend `sulla-know-what-you-cannot-do`** (no new skill): add the current hard limits people hit. There is no tool to drive the human's own Chrome tabs (the browser tools drive Sulla's built-in browser), no tool to read macOS privacy permissions, and no smart-TV control.
    Closes: "control my Chrome tabs", "which apps have Accessibility permission?", "can you control my smart TV?".

### Partial rows the owners of existing skills could close

- `sulla-tool-applescript` and `sulla-host-vs-vm`: no worked recipes yet (see 22).
- `sulla-tool-vault`: lists every tool but has no "connect an integration" walkthrough (see 5).
- `sulla-tool-github`: lists every tool but no end-to-end flow for a normal repo (see 2 and 3).
- `sulla-mobile` and `sulla-cloud` subjects: no skill points at them (see 20).
- Being improved: "make this your goal and don't stop", "where are we with all this?", "check on the workers every five minutes", "let me know if anything fails overnight", "what do I keep doing by hand that could be automated?" and "package this app as a one-click recipe" are partial and belong to the writers named above.

## Use cases by area

### Conversation and replies

7 covered, 1 partial, 0 gap.

| Use case | Coverage | Skills |
|---|---|---|
| show me last month's numbers as a chart | covered | `sulla-reply-with-rich-html` |
| give me a quick status table of everything that's running | covered | `sulla-reply-with-rich-html` |
| where did you get that? cite your sources | covered | `sulla-cite-sources` |
| rewrite this so it's shorter and plainer | covered | `sulla-write-for-a-human` |
| you're giving me too much at once, ask me one thing at a time | covered | `sulla-ask-the-human`, `sulla-write-for-a-human` |
| I need you to pick option A or B with me before you go on | covered | `sulla-ask-the-human` |
| keep the plan open on the side so I can see it while we talk | covered | `sulla-tool-chat` |
| I'm driving, keep your answers short | partial | `sulla-write-for-a-human` |

### Research and the web

3 covered, 2 partial, 6 gap.

| Use case | Coverage | Skills |
|---|---|---|
| research our top competitors and save a brief | gap | - |
| find out how this company gets its customers | gap | - |
| look into this business's website and tell me what they do | partial | `sulla-tool-browser` |
| read this article and summarize it for me | covered | `sulla-tool-browser` |
| find the most popular tools in this space and why people like them | gap | - |
| find reliable research on this question and give me the takeaways | gap | - |
| browse this in the background without touching my tabs | covered | `sulla-tool-browser` |
| save this link so we can find it again | covered | `sulla-tool-bookmarks` |
| pull all the listings from this site into a spreadsheet | gap | - |
| build a lead list from these public directories | gap | - |
| check this site every day and tell me what's new | partial | `sulla-build-workflow`, `sulla-schedule-or-trigger-workflow` |

### Writing, marketing and content

1 covered, 3 partial, 6 gap.

| Use case | Coverage | Skills |
|---|---|---|
| write the homepage copy for this product | partial | `sulla-write-for-a-human` |
| draft a week of social posts from our latest update | gap | - |
| write a video script with a strong hook | partial | `sulla-write-for-a-human` |
| make a short explainer video for this feature | gap | - |
| plan a content calendar for next month | gap | - |
| give me a marketing plan to get more sign-ups | gap | - |
| write a newsletter for our subscribers | partial | `sulla-write-for-a-human` |
| make me an image for this post | gap | - |
| check this page for common SEO mistakes | gap | - |
| turn these meeting notes into a clean summary doc | covered | `sulla-write-for-a-human`, `sulla-save-work-in-files` |

### Design and mockups

0 covered, 4 partial, 2 gap.

| Use case | Coverage | Skills |
|---|---|---|
| show me three mockups of this page | partial | `sulla-spawn-and-manage-agents` |
| open the mockup in my browser | partial | `sulla-tool-browser` |
| give me ten hero variations on one page so I can pick | gap | - |
| restyle this to match our brand, not your default theme | gap | - |
| I like option two, build it into the real app | partial | `sulla-spawn-and-manage-agents` |
| serve these HTML files from a container so I can click around | partial | `sulla-tool-docker` |

### Coding and GitHub

6 covered, 8 partial, 4 gap.

| Use case | Coverage | Skills |
|---|---|---|
| fix this bug in my repo and open a PR | partial | `sulla-tool-github` |
| add this feature to my app | partial | `sulla-tool-github`, `sulla-spawn-and-manage-agents` |
| review this pull request and tell me what's wrong | partial | `sulla-tool-github` |
| merge all the PRs that are ready | partial | `sulla-tool-github` |
| push my changes | covered | `sulla-tool-github` |
| what's the CI status on this branch? | covered | `sulla-tool-github` |
| CI is red, find out why and fix it | partial | `sulla-tool-github` |
| I got a build error, here's the log | gap | - |
| create an issue for this bug | covered | `sulla-tool-github` |
| resolve the merge conflicts on this PR | partial | `sulla-tool-github` |
| clean up all the old worktrees | covered | `sulla-tool-github` |
| set up a GitHub Action that deploys when main changes | gap | - |
| bring every PR that should ship into one release | partial | `sulla-tool-github` |
| cut a release and write the notes | partial | `sulla-tool-github` |
| add a new tool to Sulla Desktop | covered | `sulla-change-sulla-source` |
| Sulla has a bug in its own code, fix it | covered | `sulla-change-sulla-source` |
| build a Chrome extension from this mockup | gap | - |
| package the extension and update the store listing | gap | - |

### Deploy and hosting

1 covered, 2 partial, 5 gap.

| Use case | Coverage | Skills |
|---|---|---|
| deploy this website | gap | - |
| put this site behind a simple password | gap | - |
| get this out to staging | gap | - |
| is this live in production yet? | gap | - |
| the deployed site throws an error, find it and fix it | partial | `sulla-tool-browser` |
| point my domain at the new site | gap | - |
| run the deploy workflow on GitHub | covered | `sulla-tool-github` |
| bring the local dev stack back up with test data | partial | `sulla-tool-docker` |

### Testing and QA

3 covered, 2 partial, 0 gap.

| Use case | Coverage | Skills |
|---|---|---|
| test the whole app in the browser and fix what's broken | partial | `sulla-tool-browser`, `sulla-spawn-and-manage-agents` |
| did you actually look at it? check it visually | covered | `sulla-tool-browser`, `sulla-validate-before-done` |
| log in to the staging site and walk through signup | partial | `sulla-tool-browser`, `sulla-tool-vault` |
| watch the network and tell me which requests fail | covered | `sulla-tool-browser` |
| make sure it's really done before you tell me | covered | `sulla-validate-before-done` |

### Sub-agents and delegation (being improved)

8 covered, 1 partial, 0 gap.

| Use case | Coverage | Skills |
|---|---|---|
| use sub-agents to get this done faster | covered | `sulla-spawn-and-manage-agents`, `sulla-tool-agents` |
| hand the coding to cheaper workers and review their work | covered | `sulla-spawn-and-manage-agents` |
| how are the workers doing? | covered | `sulla-tool-agents` |
| kill that job | covered | `sulla-tool-agents` |
| talk to the other agents, don't assume what they did | covered | `sulla-message-another-agent` |
| which agent should handle this? | covered | `sulla-tool-agents` |
| make me a custom agent for this job | covered | `sulla-create-agent` |
| run this agent with a different model | partial | `sulla-create-agent` |
| what's on the work scoreboard? | covered | `sulla-tool-ledger` |

### Goals and projects (being improved)

2 covered, 3 partial, 0 gap.

| Use case | Coverage | Skills |
|---|---|---|
| make this your goal and don't stop until it's done | partial | `sulla-manage-a-project` |
| start a project for this and track the tasks | covered | `sulla-manage-a-project` |
| where are we with all this? | partial | `sulla-manage-a-project` |
| plan this out before you start building | partial | `sulla-spawn-and-manage-agents`, `sulla-manage-a-project` |
| review everything, find the gaps and add tasks | covered | `sulla-manage-a-project` |

### Files and documents (being improved)

6 covered, 3 partial, 0 gap.

| Use case | Coverage | Skills |
|---|---|---|
| where should I save this report? | covered | `sulla-save-work-in-files`, `sulla-tool-files` |
| put this finished document in Files | covered | `sulla-save-work-in-files` |
| find the file about our pricing | covered | `sulla-tool-files` |
| restore the previous version of that file | covered | `sulla-save-work-in-files`, `sulla-tool-files` |
| send me a share link for this file | covered | `sulla-tool-files` |
| I don't see the files you made in my file manager | partial | `sulla-save-work-in-files` |
| read this PDF and pull out the key terms | partial | `sulla-tool-files` |
| find that doc in my Google Drive | covered | `sulla-tool-gdrive` |
| download the spreadsheet from Drive and analyze it | partial | `sulla-tool-gdrive` |

### Memory, rules and identity

7 covered, 1 partial, 0 gap.

| Use case | Coverage | Skills |
|---|---|---|
| remember that I prefer short answers | covered | `sulla-remember-and-recall` |
| forget that | covered | `sulla-remember-and-recall` |
| what do you know about me? | covered | `sulla-remember-and-recall` |
| what did we decide about this last week? | covered | `sulla-remember-and-recall`, `sulla-tool-memory` |
| make that a rule for every agent | covered | `sulla-tool-rules` |
| turn this process into a skill so you do it the same way | covered | `sulla-create-skill` |
| my business goals changed, update them | partial | `sulla-remember-and-recall` |
| you keep choosing the wrong tool for this, learn it | covered | `sulla-tool-reflex` |

### Workflows, functions and automation (being improved)

7 covered, 4 partial, 0 gap.

| Use case | Coverage | Skills |
|---|---|---|
| make a workflow that runs every morning | covered | `sulla-build-workflow`, `sulla-schedule-or-trigger-workflow` |
| schedule this report for weekdays | covered | `sulla-schedule-or-trigger-workflow` |
| my workflow run failed, figure out why | covered | `sulla-debug-workflow-run` |
| restart that workflow from where it failed | covered | `sulla-debug-workflow-run` |
| what's scheduled to run? | covered | `sulla-schedule-or-trigger-workflow` |
| what do I keep doing by hand that could be automated? | partial | `sulla-tool-workflow` |
| build me a function that converts these files | covered | `sulla-build-function` |
| run my function and show the output | covered | `sulla-tool-function` |
| why did my function fail? | partial | `sulla-tool-function`, `sulla-build-function` |
| triage my inbox every morning and send me a brief | partial | `sulla-build-workflow` |
| remind customers when an invoice is overdue | partial | `sulla-build-workflow` |

### Heartbeat and background work (being improved)

3 covered, 3 partial, 0 gap.

| Use case | Coverage | Skills |
|---|---|---|
| what's the heartbeat doing? | covered | `sulla-configure-heartbeat` |
| pause the heartbeat | covered | `sulla-configure-heartbeat` |
| only run the heartbeat during working hours | covered | `sulla-configure-heartbeat` |
| check on the workers every five minutes and wake me if something breaks | partial | `sulla-configure-heartbeat` |
| let me know if anything fails overnight | partial | `sulla-tool-notify`, `sulla-configure-heartbeat` |
| I'm stepping away, keep going on your own | partial | `sulla-tool-bridge` |

### Marketplace and extensions (being improved)

6 covered, 1 partial, 0 gap.

| Use case | Coverage | Skills |
|---|---|---|
| what can I install? | covered | `sulla-install-from-marketplace` |
| install the CRM for me | covered | `sulla-install-from-marketplace`, `sulla-tool-extensions` |
| is that extension running? start it | covered | `sulla-tool-extensions` |
| update this to the latest version | covered | `sulla-install-from-marketplace` |
| publish my skill to the marketplace | covered | `sulla-publish-use-case` |
| build an extension that adds a new screen | covered | `sulla-build-extension` |
| package this app as a one-click recipe | partial | `sulla-build-extension` |

### Integrations and credentials

2 covered, 4 partial, 4 gap.

| Use case | Coverage | Skills |
|---|---|---|
| connect my GitHub account | partial | `sulla-tool-vault` |
| what integrations do I have connected? | covered | `sulla-tool-vault` |
| I put the API key in the vault, test that it works | partial | `sulla-tool-vault` |
| pull the open deals from my CRM | gap | - |
| create a customer in our billing system | gap | - |
| call this service's API with my saved key | partial | `sulla-discover-and-call-tools` |
| connect this MCP server and use its tools | partial | `sulla-discover-and-call-tools` |
| walk me through making an API token with the right permissions | gap | - |
| log in to this site with my saved password | covered | `sulla-tool-vault`, `sulla-tool-browser` |
| the OAuth sign-in fails with an error, fix it | gap | - |

### Email and messaging

2 covered, 1 partial, 4 gap.

| Use case | Coverage | Skills |
|---|---|---|
| draft a reply to this customer email | gap | - |
| go through my inbox and tell me what needs me | gap | - |
| send these emails five at a time until they're all out | gap | - |
| send a Slack message to the team channel | covered | `sulla-tool-slack` |
| read that Slack thread and summarize it | covered | `sulla-tool-slack` |
| send a text message to this customer | gap | - |
| send that through Mail on my Mac | partial | `sulla-tool-applescript` |

### Calendar, reminders and notifications

3 covered, 2 partial, 2 gap.

| Use case | Coverage | Skills |
|---|---|---|
| what's on my calendar this week? | covered | `sulla-tool-calendar` |
| schedule a meeting tomorrow at 2pm | covered | `sulla-tool-calendar` |
| remind me to check the deploy in 10 minutes | partial | `sulla-tool-browser` |
| remind me every Monday to place the order | gap | - |
| notify me when it's done | covered | `sulla-tool-notify` |
| prep me for this week's meetings | partial | `sulla-tool-calendar` |
| plan my week around these fixed commitments | gap | - |

### Data and analytics

1 covered, 3 partial, 2 gap.

| Use case | Coverage | Skills |
|---|---|---|
| how many signups did we get this week? | partial | `sulla-tool-pg`, `sulla-reply-with-rich-html` |
| build me a dashboard of these KPIs | partial | `sulla-reply-with-rich-html`, `sulla-spawn-and-manage-agents` |
| query the database for orders over 100 | covered | `sulla-tool-pg` |
| analyze this spreadsheet and tell me the trends | gap | - |
| why are my AI costs climbing? | partial | `sulla-tool-models` |
| make a monthly report of what we did for this client | gap | - |

### System health, Docker and the VM

3 covered, 4 partial, 4 gap.

| Use case | Coverage | Skills |
|---|---|---|
| I just restarted, run some diagnostics | gap | - |
| did everything from last night get in? | gap | - |
| we crashed, pick up where you left off | gap | - |
| what containers are running? | covered | `sulla-tool-docker` |
| show me the logs from that container | covered | `sulla-tool-docker` |
| restart Postgres | partial | `sulla-tool-docker` |
| build and run this app in a container | partial | `sulla-tool-docker` |
| check Postgres before doing anything else | partial | `sulla-tool-pg` |
| how is the VM running? | partial | `sulla-host-vs-vm` |
| why can't you see this folder on my Mac? | covered | `sulla-host-vs-vm` |
| something is eating memory, find it | gap | - |

### Sulla Desktop app and settings

5 covered, 3 partial, 1 gap.

| Use case | Coverage | Skills |
|---|---|---|
| change the default model | partial | `sulla-tool-settings`, `sulla-tool-models` |
| which models can I use? | covered | `sulla-tool-models` |
| is there an update? install it | covered | `sulla-handle-desktop-updates` |
| the app shows an error when I attach a file | gap | - |
| turn on host access | partial | `sulla-tool-settings`, `sulla-host-vs-vm` |
| approve or deny what's waiting in Decide | covered | `sulla-decide-approval` |
| can you do this? I'm not sure Sulla supports it | covered | `sulla-know-what-you-cannot-do` |
| what tools do you have for this? | covered | `sulla-discover-and-call-tools` |
| what is Sulla Cloud and what does it cost? | partial | - |

### Mac and host control

1 covered, 2 partial, 2 gap.

| Use case | Coverage | Skills |
|---|---|---|
| add this to my Reminders app | partial | `sulla-tool-applescript` |
| open this folder in Finder | partial | `sulla-tool-applescript`, `sulla-host-vs-vm` |
| run this command on my Mac | covered | `sulla-host-vs-vm` |
| control my Chrome tabs and set it up for me | gap | - |
| which apps have Accessibility permission? | gap | - |

### Capture, voice and meetings

4 covered, 1 partial, 2 gap.

| Use case | Coverage | Skills |
|---|---|---|
| take a screenshot of my whole screen | covered | `sulla-tool-capture` |
| record this meeting | covered | `sulla-record-with-capture-studio` |
| where are my recordings? | partial | `sulla-record-with-capture-studio` |
| take notes for this meeting | covered | `sulla-use-secretary-mode` |
| what were the action items from the call? | covered | `sulla-use-secretary-mode` |
| transcribe this old recording | gap | - |
| voice mode didn't pick anything up | gap | - |

### Mobile and Cloud

1 covered, 2 partial, 1 gap.

| Use case | Coverage | Skills |
|---|---|---|
| how do I pair my phone? | partial | - |
| is my phone connected? | covered | `sulla-tool-mobile` |
| my phone won't connect to my desktop | gap | - |
| can I see my desktop chats from the cloud? | partial | - |

### Business operations

0 covered, 2 partial, 6 gap.

| Use case | Coverage | Skills |
|---|---|---|
| help me figure out what to order this week | gap | - |
| log this expense receipt | gap | - |
| track which contracts renew soon | partial | `sulla-build-workflow` |
| capture leads from the website form into the CRM | gap | - |
| draft responses to our new reviews | gap | - |
| which customers haven't ordered lately? draft check-ins | gap | - |
| write a policy page for privacy requests | partial | `sulla-write-for-a-human` |
| is this business idea worth it? run the numbers | gap | - |

### Devices, networks and IT

0 covered, 1 partial, 3 gap.

| Use case | Coverage | Skills |
|---|---|---|
| what devices are on my network? | gap | - |
| help me get into this old server | gap | - |
| can you control my smart TV? | gap | - |
| watch my site and alert me when it goes down | partial | `sulla-install-from-marketplace` |
