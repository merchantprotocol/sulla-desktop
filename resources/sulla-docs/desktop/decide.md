# Decide: human requests and tool approval policies

The left rail **Decide** view lists durable conversation requests. Its badge counts pending and deferred requests. Approval settings is a searchable, categorized view of the same registered tools as the Sulla CLI. Selecting a tool gates each invocation; this is not a sandbox for provider-native tools, shell commands, or equivalent operations through other tools.

Requests are stored in `human_decisions`. Tool policies use `tool_approval_policies`. Migration 0098 creates both tables. No tool arguments, credentials, or executable closures are uploaded as decision records. Review the original tool call before approving. Question text is included, just as in chat history.

A request binds its ID to its original conversation and the current process session. Approve/Deny/Answer settles only the waiting call, with no new conversation or agent dispatch. Defer leaves that caller waiting until its existing expiry. A duplicate, wrong-conversation, expired, or orphaned request cannot run the action. A database failure cannot release approval. After process restart old requests are expired; ask for a new request in their original conversation. This deliberately avoids replaying a potentially completed side effect.

Native tool calls use their graph state. Provider CLI calls carry their existing MCP session identity in `SULLA_TOOL_SESSION`; the CLI forwards it in `X-Sulla-Tool-Session`, and the backend resolves the live graph rather than guessing which chat is active. A gated call without conversation context fails closed. Requests and responses use existing authenticated owner/paired-client transport. Remote callers cannot edit tool policies.

Cloud/mobile read signed Projects snapshots when Projects sync is enabled. Decision changes trigger a fresh snapshot. They can also fetch `decisions.list` and submit `decisions.resolve` through the companion channel. The response includes `settled`; clients must wait for true before showing acceptance or reopening the original conversation. Offline snapshots are not authorization to execute. Cloud clients use the existing signed paired-browser channel; mobile uses the existing authenticated companion relay. Workspace filtering remains in the device/snapshot discovery path.

Activation requires merging the Desktop, website, and mobile branches, deploying the website, updating mobile, and a Desktop restart at a user-approved time. A test build does not install or restart Desktop. Never claim live acceptance from a source build alone.
