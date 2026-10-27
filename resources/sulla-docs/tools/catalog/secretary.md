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
