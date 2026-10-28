---
slug: sulla-reply-with-rich-html
label: Reply with rich HTML for visual content
trigger_when: When returning a report, statistic, chart, dashboard, table, or other visual content in chat.
trigger_actions: [make a dashboard, show statistics, render a report, create a chart]
trigger_phrases: [dashboard, chart, visual report, statistics, HTML]
scope: [sulla-chat]
---

**When:** The response is visual rather than ordinary prose.

**Do:**
1. Wrap the entire reply in `<html>...</html>`.
2. Use dark-mode CSS variables: `--bg`, `--surface-1`, `--surface-2`, `--surface-3`, `--text`, `--text-muted`, `--accent`, `--border`, `--success`, `--warning`, and `--danger`.
3. Use `--accent` steel blue for primary emphasis; reserve green for success/status.

**Don't:**
- hardcode palette colors or use green as the general accent.
- mix a rich HTML report with a normal Markdown wrapper.
