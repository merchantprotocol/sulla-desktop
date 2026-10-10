# Custom agents plan

1. Add testable filesystem CRUD and IPC handlers for `~/sulla/agents/<slug>`.
2. Add create, edit, and delete controls to the existing Agents page.
3. Store model or custom-agent selection in each serialized chat thread.
4. Pass that selection to the backend without changing global defaults.
5. Cover YAML preservation and chat isolation with focused tests.
