# Two-device QA evidence harness

`twodev.sh` produces repeatable evidence for the two-device org proof (acceptance checks A1–A6 in `Projects/sulla-desktop/plans/two-device-org-proof.md`). Two real Sulla Desktops on production Sulla Cloud: side **A** is this Mac, side **B** is the Intel iMac, reached only over `ssh`.

The script runs on the **Mac host shell** (bash or zsh, macOS). The `sulla` CLI is **not** installed in the Desktop VM or on the host, so the script does not call it. Each Desktop's own agent runs the sulla tool instead. The script asks that agent, through the Desktop's local chat API, to run exactly one named sulla tool and reply with a JSON object of ids.

## How a step runs

1. `ask_agent <a|b> <prompt>` runs on the Mac that owns the Desktop: locally for `a`, or `ssh Jonathons-iMac.local 'bash -s'` for `b`. The prompt is sent on stdin as base64, never on argv.
2. On that Mac, a small Python process reads the chat API token from `~/Library/Application Support/sulla-desktop/chat-api-token.json` and sends it as an `Authorization: Bearer` header. The token is never printed, logged or put on a command line.
3. It POSTs one non-streaming `POST http://127.0.0.1:3000/v1/chat/completions` with `model` set to `${TWODEV_AGENT:-sulla-desktop}` and a 600 s timeout, then prints only the assistant text.
4. The script parses the first complete JSON object in that reply. It logs only ids and flags, never the reply text.

## Requirements

- `bash`, `python3` (stdlib only, run with `-I`), `base64`, `ssh`.
- A Sulla Desktop running on each Mac, with its local API on `127.0.0.1:3000` and its chat token file present.
- `ssh Jonathons-iMac.local` works with key auth (`BatchMode=yes`, so no password prompts).

## Environment variables

| Variable | Needed by | Meaning |
|---|---|---|
| `A_USER` | a1, a2-send | userId of user A (the Mac). Must appear in B's directory. |
| `B_USER` | a1, a2-send | userId of user B (the iMac). Must appear in A's directory. |
| `B_AGENT_ID` | a2-send | agentId of B's agent (recipient). |
| `TWODEV_CONVERSATION_ID` | a2-send, a2-reply (optional) | Conversation to use. If unset, a2-send takes `conversationId` from A's directory reply. |
| `TWODEV_NONCE` | a2-check, a2-reply, a4 (optional) | Fixed nonce. Otherwise one is generated per run. |
| `TWODEV_AGENT` | all (optional) | Agent model id for the chat API. Default `sulla-desktop`. Letters, digits, `.`, `_`, `-` only. |
| `TWODEV_ORG` | all (optional) | Org id, passed to `org/directory` as `{"org": ...}`. Unset means the active org. |
| `TWODEV_FOLDER` | a4 (optional) | Files folder under `/mnt/sulla-files`. Default `Projects/sulla-desktop/qa/two-device`. |
| `TWODEV_IMAC_HOST` | all (optional) | Default `Jonathons-iMac.local`. |
| `TWODEV_APP_PATH` | inventory (optional) | Default `/Applications/Sulla Desktop.app`. |
| `TWODEV_OUT` | all (optional) | Evidence directory. Default `~/Sites/sulla/_wt/twodev-evidence`. |

## Steps

```bash
cd scripts/qa/two-device
./twodev.sh preflight                         # both Macs: one PONG round trip each, PASS or FAIL with a reason
./twodev.sh inventory                         # both Macs: version, codesign team id, uptime, org/directory
A_USER=<userA> B_USER=<userB> ./twodev.sh a1  # each side's directory lists the other user
A_USER=<userA> B_USER=<userB> B_AGENT_ID=<agentB> ./twodev.sh a2-send
./twodev.sh a2-reply                          # B's agent replies with the nonce (after a2-send)
./twodev.sh a2-check                          # B's agent looks for the nonce in its org inbox (MANUAL if it can't)
./twodev.sh a4 a                              # Mac's agent writes a file, searches for it in Mac File Manager
./twodev.sh a4 b                              # same on the iMac
./twodev.sh a5                                # TODO: org sharing not built
./twodev.sh a6                                # TODO: org sharing not built
```

Each agent prompt asks for exactly one sulla tool call and a reply of ids only. An agent that adds prose, skips the tool, or returns `ok:false` makes the step fail with exit 1.

**Preflight.** Every step runs `preflight` for the side(s) it uses before any QA call: the agent gets `Reply with exactly: PONG`. A missing PONG stops the step with exit 1 and a reason. `./twodev.sh preflight` runs both sides and reports each one.

**Waiting lines.** Each agent call prints `waiting on A-mac agent…` (or `B-imac`) on stderr before it starts. A Mac run can take minutes.

**Failure reasons.** When an agent call fails, the operator sees a short sanitized snippet of the reply (first 160 characters, with emails, phone numbers and token-like strings redacted). The machine reason is one of: `model_signin_expired` ("sign-in expired" or "Reconnect in Settings"), `rate_limited`, `timeout`, `no_json_reply`, `no_pong_reply`, `agent_reported_error`, `transport_failed` (ssh or the local chat API did not answer).

## What PASS means

- **A1 PASS:** A's `org/directory` reply lists B's `B_USER`, and B's reply lists A's `A_USER`. Both agents report `ok:true`. This proves both users are in one org. The Cloud People page still needs a screenshot.
- **A2:** `a2-send` prints `SENT` when A's agent reports `ok:true` for `org/send_message`, and it saves the nonce and conversationId to `$TWODEV_OUT/last-a2.json`. That is not delivery. `a2-reply` asks B's agent to answer in the same conversation. `a2-check` asks B's agent to search its org inbox and pending requests for the nonce. If the agent reports it found the nonce, the step prints `AGENT-REPORTED-FOUND`. That is still not PASS, because the agent's own report is the only evidence. Otherwise it prints `MANUAL`. A2 passes only after a human sees the nonce in both Cloud threads.
- **A4 PASS:** B's or A's agent writes the file under `/mnt/sulla-files/<TWODEV_FOLDER>` with its write_file tool, then runs `files/search` for that name. The step passes when the agent reports `found:true`, with up to 4 tries. Take a File Manager screenshot for the proof report. Search proves indexing, not what the UI shows.
- **A5, A6:** TODO. Exit code 2 and `TODO` means not run, not a failure. Org sharing is not built yet.

Exit codes: 0 = PASS or ok, 1 = FAIL, 2 = usage, missing env, or TODO/not run.

## Evidence log

Each run appends one JSON line per agent call to `$TWODEV_OUT/evidence-<UTC date>.jsonl`:

```json
{"check":"a1","command":"org/directory","exit":0,"ids":{"orgId":"…","userIds":["…"],"agentIds":["…"]},"machine":"A-mac","ts":"2026-11-17T00:00:00+00:00"}
```

- Records the check, machine label (`A-mac` or `B-imac`), the sulla tool name, exit code, and extracted ids (`userIds`, `agentIds`, `orgId`/`teamId`, `conversationId`, `messageId`, `fileId`, and the run's `nonce`, `file` and `found` flags).
- Never logged: the chat API token, reply text, error text, emails, phone numbers, message bodies, or raw directory output. The prompt is never logged either, so message text never reaches the log.
- On failure a call logs only `{"ok":false,"error":"<machine reason>"}`, with no ids.

## Known gaps

- `a2-check` depends on B's agent finding a tool that can read the org inbox. If no such tool exists, it reports `MANUAL`. Check B's Cloud thread by hand for the nonce.
- Agent replies are self-reports. Every PASS from an agent step should be confirmed by a screenshot or a Cloud UI check before it goes in the proof report.
- A4 writes a test file into the real Files tree (`TWODEV_FOLDER`). Delete it after the proof run, or keep it as evidence.
- Screenshots (A1 People page, A3 Conversations, A4 File Manager, A6) are taken by hand. The script does not capture them.
- The script has not been run end to end on the two Macs from this branch. It was checked with `bash -n` only.
