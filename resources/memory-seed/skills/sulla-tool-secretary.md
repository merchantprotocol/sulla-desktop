---
slug: sulla-tool-secretary
label: Use the Sulla Secretary tools
trigger_when: When you need to use Sulla Secretary operations.
trigger_actions: [secretary, secretary tools]
trigger_phrases: [secretary, secretary]
scope: [tool-secretary]
---

**When:** When you need to use Sulla Secretary operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# secretary tools

Secretary Mode control — start, stop, and check live meeting transcription without pressing Cmd+Shift+S.

## start

Start Secretary Mode — opens (or focuses) a Secretary tab and auto-begins the listening session. Use when the user asks to "start taking notes", "enter secretary mode", "listen to my meeting", etc.

**Parameters**

None.

**Example**

```bash
sulla secretary/start '{}'
```

## status

Check whether Secretary Mode is currently listening. Returns JSON { listening: boolean, tabId: string | null }.

**Parameters**

None.

**Example**

```bash
sulla secretary/status '{}'
```

## stop

Stop Secretary Mode — ends the active listening session. Use when the user asks to "stop taking notes", "end secretary mode", "stop listening".

**Parameters**

None.

**Example**

```bash
sulla secretary/stop '{}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
