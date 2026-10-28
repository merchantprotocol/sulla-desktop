---
slug: sulla-reply-with-rich-html
label: Present a clear report, KPI dashboard, chart, or table in chat
trigger_when: When real data or a comparison is easier to understand as a polished visual report, KPI strip, chart, or table.
trigger_actions: [make a dashboard, show a KPI, render a report, create a chart, compare data]
trigger_phrases: [build me a dashboard, chart these KPIs, visual report, show the trend, statistics, KPI tiles, compare these numbers]
scope: [sulla-chat]
---

**When:** The response is visual rather than ordinary prose.

**Do:**
1. Verify the numbers and decide what the reader must notice. Lead with the answer, not the decoration. Include source, time window, time zone, filters, comparison period, and caveats.
2. Choose the smallest honest form: one KPI card for one number; a line for change over time; bars for category comparison; a table for exact values. Avoid a chart when one sentence or a small table is clearer.
3. Wrap the entire response in `<html>...</html>`. Put prose, component, provenance, and caveats inside the wrapper; do not add Markdown outside it.
4. Use semantic HTML and inline `<style>`. Chat strips `<script>` and `<svg>`, so use HTML/CSS only. Keep the response compact and readable on narrow screens.
5. Use the chat variables: `--bg`, `--surface-1`, `--surface-2`, `--surface-3`, `--text`, `--text-muted`, `--text-dim`, `--accent`, `--accent-hover`, `--accent-dim`, `--accent-border`, `--border`, `--border-muted`, `--info`, `--success`, `--warning`, and `--danger`. Use `var(--font-display)` for a headline, `var(--font-body)` for prose, and `var(--font-mono)` for data or code.
6. Use `--accent` for primary emphasis. Reserve green/`--success` for a genuinely successful status. Give tables headings, charts a text summary, and status meaning in words rather than color alone.
7. Label estimates, sample data, incomplete periods, missing data, and units directly beside the affected value. For several real metrics, use the Everyday work memory pack's `sulla-analyze-data` skill, if installed or the `analytics-worker` instead of inventing dashboard data.

**Check:** Every displayed number matches the verified source; the takeaway is visible in five seconds; the response works without scripts or SVG; provenance and caveats are present; success is not communicated by color alone.

**Cleanup:** Remove any temporary render specs, exported HTML, and screenshots used to inspect the component. Do not save a chat-only dashboard to Files unless the human wants a durable report.

**Don't:**
- Don't hardcode palette colors or use green as the general accent.
- Don't mix a rich HTML report with a normal Markdown wrapper.
- Don't fabricate values, hide uncertainty, use a dual axis, or make a rainbow chart.
- Don't embed remote scripts, tracking pixels, forms, or active content.
