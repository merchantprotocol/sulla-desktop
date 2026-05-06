# Sulla Design System — HTML Project Documents

All project documentation, PRDs, dashboards, reports, and roadmaps **must** be HTML files using the Sulla design system — not markdown. HTML renders directly in Sulla chat and looks like a native UI extension.

## Files (bundled with every install)

| File | Purpose |
|------|---------|
| `sulla.css` | Standalone design system CSS — all tokens, components, themes |
| `template.html` | Full starter template showing every component with usage examples |

At runtime these resolve to:
```
<app-resources-path>/sulla-docs/design-system/sulla.css
<app-resources-path>/sulla-docs/design-system/template.html
```

## Quick start — creating a new project doc

1. Copy `template.html` to the project directory (e.g. `~/sulla/projects/my-project/overview.html`)
2. Update the `<link>` path to point back to `sulla.css` (relative or absolute)
3. Change `<html class="dark">` to `class="light"` for light mode, or leave it for dark
4. Replace the demo content — keep the structure

```html
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <title>My Project — Sulla</title>
  <link rel="stylesheet" href="/Users/jonathonbyrdziak/Sites/sulla/sulla-desktop/resources/sulla-docs/design-system/sulla.css">
</head>
<body>
  <div class="sulla-page">
    <div class="page-hero">
      <h1>Project Name</h1>
      <p>Subtitle here.</p>
    </div>
    <!-- content -->
  </div>
</body>
</html>
```

**Absolute path (always works from any project dir):**
```
/Users/jonathonbyrdziak/Sites/sulla/sulla-desktop/resources/sulla-docs/design-system/sulla.css
```

## Themes

| Class on `<html>` | Look |
|-------------------|------|
| `class="dark"` | Protocol Dark — `#0d1117` background, steel blue `#5096b3` accent |
| `class="light"` | Protocol Light — `#f4f7fb` background, same steel blue accent |
| _(none)_ | Auto-detects OS preference |

Theme toggles at runtime via the included JS snippet in `template.html`.

## CSS variables (key subset)

```css
/* Surfaces */
--bg          /* page background */
--surface-1   /* cards, panels */
--surface-2   /* nested panels */
--surface-3   /* hover states */

/* Text */
--text           /* primary */
--text-secondary
--text-muted
--text-dim

/* Brand */
--accent         /* #5096b3 steel blue (dark) / #0ea5e9 sky (light) */
--accent-hover
--accent-dim     /* subtle fill */
--accent-border  /* border with alpha */

/* Status */
--success  --warning  --danger  --info

/* Borders */
--border        /* default */
--border-muted  /* subtle */
--border-strong /* emphasized */

/* Shadows */
--shadow-sm  --shadow-md  --shadow-lg

/* Typography */
--font-mono     /* JetBrains Mono — body, code, UI */
--font-display  /* Playfair Display — headings */
```

## Component classes (quick reference)

**Layout**
- `.sulla-page` — simple centered page (max 900px)
- `.sulla-page-wide` — wide centered page (max 1200px)
- `.sulla-app` + `.sulla-sidebar` + `.sulla-main` — full sidebar layout
- `.sulla-header` — sticky top bar
- `.sulla-content` — content area with padding
- `.page-hero` — page title + subtitle block
- `.section` + `.section-header` + `.section-title` + `.section-rule` — labeled section

**Components**
- `.card` `.card-lg` `.card-success/warning/danger/info/accent` — surfaces
- `.grid-2/3/4` `.grid-auto` — CSS grid layouts
- `.stat` `.stat-value` `.stat-label` `.stat-delta` — KPI numbers
- `.badge-accent/success/warning/danger/info/default` `.badge.pill` `.badge.with-dot` — status tags
- `.table-wrap` + `.sulla-table` — data tables
- `.checklist` with `li.done` / `li.in-progress` — task lists
- `.timeline` with `.timeline-item.done/.active/.blocked` — project timelines
- `.terminal` — terminal/log output block
- `.alert-success/warning/danger/info/accent` — notice boxes
- `.progress-bar` + `.progress-fill.success/warning/danger` — progress bars
- `.btn-primary` `.btn-ghost` `.btn-outline-accent` `.btn-sm` `.btn-xs` — buttons
- `.meta-grid` + `.meta-key` + `.meta-val` — key-value metadata
- `.divider` — labeled horizontal rule

**Utilities:** `.flex` `.items-center` `.justify-between` `.gap-1..8` `.mt/mb-1..8` `.text-xs..3xl` `.font-mono` `.font-display` `.text-accent/success/warning/danger/muted/dim` `.rounded` `.w-full` `.truncate` `.glow-text`

## Output conventions

- Default all new project HTML to `class="dark"` (Protocol Dark)
- Include the theme toggle `<script>` block from `template.html` so users can switch
- Store project files at `~/sulla/projects/<project-name>/`
- Use absolute path to `sulla.css` so files open correctly from any location
- One file per document type: `overview.html`, `roadmap.html`, `competitor-analysis.html`, etc.
