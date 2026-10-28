# Outbound send guard

A real Extension Contract v1 hook. It registers a `before_tool_call` filter and blocks any tool call whose name sends, posts, publishes, pays, charges or deletes, so a person approves it first. Everything else passes through unchanged. Reversible actions such as merging a PR are not blocked.

- **Needs connected:** nothing. It only reads the tool name from the secret-redacted hook payload.
- **Grant:** Sulla asks the first time the hook would run. Until you allow it, the hook is skipped.
- **Tune it:** edit `BLOCKED` and `ALLOWED` in `main.py`.
