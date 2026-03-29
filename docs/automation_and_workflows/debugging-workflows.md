# Debugging Workflows

If a workflow is not working, you can debug it in two ways:

1. Ask your AI executive assistant (Sulla) to investigate and fix it
2. Run manual debugging steps yourself

## Fastest path: ask Sulla to debug it

When something breaks, tell Sulla exactly:

- What workflow failed
- What you expected to happen
- What actually happened
- Any error message shown
- Which step/node appears to fail

Sulla can then test and debug the workflow, suggest fixes, and apply revisions.

## Prompt template for AI-assisted debugging

Use a message like:

"Debug my workflow called [workflow name]. It should [expected behavior], but instead [actual behavior]. The failure appears at [step/node]. Error message: [error]. Please test and revise the workflow."

## Manual workflow debugging steps

If you want to debug manually, use this sequence:

1. Open the workflow in the Automation/Workflow system.
2. Check the trigger configuration first (schedule, webhook, or event source).
3. Run the workflow in test mode.
4. Inspect each step output to find the first failing step.
5. Validate credentials/integrations used by that step.
6. Confirm expected input fields exist and are correctly mapped.
7. Re-test after each small change.

## Log files

All agent and workflow logs are written to `~/sulla/logs/` by SullaLogger. Useful files for debugging:

| File | What to look for |
|------|-----------------|
| `index.log` | Conversation start/complete entries — confirm your workflow or graph was created |
| `{channel}_{threadId}.log` | Full event stream for a specific conversation (messages, tool calls, LLM calls) |
| `websocket.log` | WebSocket connection state — check if messages were queued, sent, ACK'd, or expired |
| `persona.log` | Message delivery from the chat interface to the WebSocket layer |
| `frontend-graph.log` | Message routing and graph execution lifecycle |
| `dispatcher.log` | Message validation — look for dropped or malformed messages |

Tail any log in real time:

```bash
tail -f ~/sulla/logs/websocket.log
```

## Common failure points

- Missing or expired service credentials
- Wrong field mapping between steps
- Trigger misconfiguration (wrong schedule, wrong event, disabled trigger)
- Invalid filters or conditions
- Rate limits or provider-side API errors

## Best practice for fixing issues

- Change one thing at a time.
- Re-run with a small test payload.
- Confirm the failing step is fixed before moving on.
- Ask Sulla to optimize the workflow after it is stable.

## When to use AI vs manual

- Use **AI-first** for speed and automatic troubleshooting.
- Use **manual debugging** when you want deeper control over specific nodes/logic.

Most users should start by asking Sulla to debug, then review the updated workflow and request follow-up revisions if needed.
