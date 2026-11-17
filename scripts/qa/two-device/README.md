# Two-device QA evidence harness

`twodev.sh` produces repeatable evidence for the two-device org proof (acceptance checks A1–A6 in `Projects/sulla-desktop/plans/two-device-org-proof.md`). Two real Sulla Desktops on production Sulla Cloud: side **A** is this Mac, side **B** is the Intel iMac, reached only over `ssh`.

The script runs on the **Mac host shell** (bash or zsh, macOS). It never runs the `sulla` CLI on the host. Each Desktop's VM has the CLI, so every call goes through `sulla-runtime exec -- sulla <category>/<tool> '<json>'`.

## Requirements

- `bash`, `python3` (stdlib only, run with `-I`), `ssh`.
- `sulla-runtime` on `PATH`, or the bundled copy at `/Applications/Sulla Desktop.app/Contents/Resources/resources/darwin/sulla-runtime/sulla-runtime`. The script checks both on each machine and fails with a clear message if neither exists.
- `ssh Jonathons-iMac.local` works with key auth (`BatchMode=yes`, so no password prompts).

## Environment variables

| Variable | Needed by | Meaning |
|---|---|---|
| `A_USER` | a1, a2-send | userId of user A (the Mac). Must appear in B's directory. |
| `B_USER` | a1, a2-send | userId of user B (the iMac). Must appear in A's directory. |
| `B_AGENT_ID` | a2-send | agentId of B's agent (recipient). |
| `TWODEV_CONVERSATION_ID` | a2-send (optional) | Conversation to send in. If unset, the script takes `conversationId` from A's directory. |
| `TWODEV_ORG` | all (optional) | Org id. Passed as `{"org": ...}`. Unset means the active org. |
| `TWODEV_NONCE` | a2-check, a4 (optional) | Fixed nonce. Otherwise one is generated per run. |
| `TWODEV_FOLDER` | a4 (optional) | Files folder under `/mnt/sulla-files`. Default `Projects/sulla-desktop/qa/two-device`. |
| `TWODEV_IMAC_HOST` | all (optional) | Default `Jonathons-iMac.local`. |
| `TWODEV_APP_PATH` | inventory (optional) | Default `/Applications/Sulla Desktop.app`. |
| `TWODEV_OUT` | all (optional) | Evidence directory. Default `~/Sites/sulla/_wt/twodev-evidence`. |

## Steps

```bash
cd scripts/qa/two-device
./twodev.sh inventory                         # both Macs: version, codesign team id, uptime, org/directory
A_USER=<userA> B_USER=<userB> ./twodev.sh a1  # each side's directory lists the other user
A_USER=<userA> B_USER=<userB> B_AGENT_ID=<agentB> ./twodev.sh a2-send
./twodev.sh a2-check                          # B-side thread check (manual, see below)
./twodev.sh a4 a                              # AI on Mac writes a file, searches for it in Mac File Manager
./twodev.sh a4 b                              # same on the iMac
./twodev.sh a5                                # TODO: org sharing not built
./twodev.sh a6                                # TODO: org sharing not built
```

## What PASS means

- **A1 PASS:** A's `org/directory` contains B's `B_USER`, and B's `org/directory` contains A's `A_USER`. Both calls exit 0. This proves both users are in one org. The Cloud People page still needs a screenshot.
- **A2:** `a2-send` prints `SENT` when `org/send_message` exits 0 and logs the nonce. That is not delivery. Delivery and B's reply need a human check of the thread on B (`a2-check` prints the endpoint). A2 passes only when B's agent's reply is visible on both sides. Until then the step reports `MANUAL`.
- **A4 PASS:** the file was written under `/mnt/sulla-files/<TWODEV_FOLDER>` on that side and `files/search` returns its name within 4 tries. Take a File Manager screenshot for the proof report. Search proves indexing, not what the UI shows.
- **A5, A6:** TODO. Exit code 2 and `TODO` means not run, not a failure. Org sharing is not built yet.

Exit codes: 0 = PASS or ok, 1 = FAIL, 2 = usage, missing env, or TODO/not run.

## Evidence log

Each run appends one JSON line to `$TWODEV_OUT/evidence-<UTC date>.jsonl`:

```json
{"check":"a1","command":"sulla org/directory","exit":0,"ids":{"teamId":"…","userId":"…"},"machine":"A-mac","ts":"2026-11-17T00:00:00+00:00"}
```

- Records the check, machine label (`A-mac` or `B-imac`), the sulla subcommand name, exit code, and extracted ids (`userId`, `orgId`/`teamId`, `conversationId`, `messageId`, `fileId`, `agentId`, `nonce`). Only ids and the nonce appear.
- Never logged: tokens, emails, phone numbers, message bodies, raw directory output. The sulla JSON arguments are not logged either, so message text never reaches the log.

## Known gaps

- `a2-check` cannot prove B's thread from the CLI. It found no verified inbox read tool in the sulla catalog, so it prints the Cloud endpoint `GET /orgs/:teamId/inbox` for a manual check.
- A4 writes a test file into the real Files tree (`TWODEV_FOLDER`). Delete it after the proof run, or keep it as evidence.
- Screenshots (A1 People page, A3 Conversations, A4 File Manager, A6) are taken by hand. The script does not capture them.
