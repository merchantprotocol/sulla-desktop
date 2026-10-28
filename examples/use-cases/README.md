# First-party Use Cases

These fourteen additive examples are small, reviewable bundles for common solo-operator jobs. Each directory contains the runnable artifact files plus a README describing connections and permissions. They are examples only: nothing here publishes to the marketplace.

| Use Case | Kind | Connected access |
|---|---|---|
| Daily inbox triage brief | Skill | Email read/search |
| Weekly calendar prep | Skill | Calendar read |
| Invoice due reminders | Function | None; offline input |
| Meeting follow-up drafts | Function | None; offline input |
| Website uptime watch | Workflow | Browser read-only |
| Web lead capture to CRM | Workflow | Form/inbox read + CRM approval-gated write |
| Outbound send guard | Function (`before_tool_call` hook) | None; reads tool names only |
| Google review response drafts | Skill | Browser/review integration read-only |
| Weekly update social drafts | Skill | Files read-only |
| Expense receipt filing | Workflow | Files read-only |
| Contract renewal tracker | Workflow | Files + Calendar read-only |
| Customer churn check-in drafts | Workflow | Owner-provided notes/Files read-only |
| Daily KPI digest | Workflow | Files read-only |
| Uptime Kuma self-hosted monitor | Recipe | Local Docker service; user configures targets |
