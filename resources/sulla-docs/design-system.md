# Sulla Design System — Project HTML Files

When creating project documents, dashboards, PRDs, or any HTML file that the user will open in a browser, use the Sulla design system so they look like a native extension of the app.

---

## File Locations

These files ship bundled with every Sulla Desktop installation:

| File | Location |
|------|----------|
| Stylesheet | `<app-resources>/design-system/sulla.css` |
| Starter template | `<app-resources>/design-system/template.html` |

They are also copied to the user's Sulla home on first use:

| File | Location |
|------|----------|
| Stylesheet | `~/sulla/designs/sulla.css` |
| Starter template | `~/sulla/designs/template.html` |

> **Always use the `~/sulla/designs/` paths** in project HTML `<link>` tags — they're stable across app upgrades and repackages.

---

## Minimal HTML stub

```html
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Project — Sulla</title>
  <link rel="stylesheet" href="../../designs/sulla.css">
  <!-- Adjust relative path from ~/sulla/projects/<name>/ to ~/sulla/designs/ -->
</head>
<body>
  <div class="sulla-page">
    <div class="page-hero">
      <h1>Project Title</h1>
      <p>Description</p>
    </div>
    <!-- content here -->
  </div>
  <script>
    (function(){
      const s = localStorage.getItem('sulla-theme');
      if (s) document.documentElement.className = s;
      else if (window.matchMedia('(prefers-color-scheme: light)').matches)
        document.documentElement.className = 'light';
    })();
  </script>
</body>
</html>
```

---

## Theme Classes

Apply to the `<html>` element:

| Class | Result |
|-------|--------|
| `class="dark"` | **Protocol Dark** — steel blue on noir black (`#0d1117` bg, `#5096b3` accent) |
| `class="light"` | **Protocol Light** — steel blue on pale blue-white (`#f4f7fb` bg, `#5096b3` accent) |
| *(none)* | Auto-detects OS `prefers-color-scheme` |

---

## CSS Variables — Quick Reference

All variables are defined in `sulla.css` and automatically apply from the active theme class.

### Colors
```css
var(--bg)            /* Page background */
var(--surface-1)     /* Cards, panels */
var(--surface-2)     /* Nested panels */
var(--surface-3)     /* Hover states */
var(--border)        /* Default border */
var(--border-muted)  /* Subtle border */
var(--text)          /* Primary text */
var(--text-secondary)
var(--text-muted)
var(--text-dim)
var(--accent)        /* Steel blue #5096b3 (dark) / sky blue (light) */
var(--success)       /* Green */
var(--warning)       /* Amber */
var(--danger)        /* Red */
var(--info)          /* Blue */
```

### Typography
```css
var(--font-mono)     /* JetBrains Mono — body, code, UI labels */
var(--font-display)  /* Playfair Display — headings */
var(--font-body)     /* System sans — long-form prose */
```

### Spacing / Radius
```css
var(--radius)     /* 4px */
var(--radius-md)  /* 6px */
var(--radius-lg)  /* 8px */
```

---

## Layout Patterns

### Simple page (no sidebar)
```html
<div class="sulla-page">       <!-- max 900px, centered, 2rem padding -->
  <div class="page-hero">...</div>
  ...
</div>
```

### Full app with sidebar
```html
<div class="sulla-app">
  <aside class="sulla-sidebar">
    <nav class="sulla-nav">
      <a href="#" class="sulla-nav-item active">Item</a>
    </nav>
  </aside>
  <div class="sulla-main">
    <header class="sulla-header">...</header>
    <div class="sulla-content">...</div>
  </div>
</div>
```

---

## Component Classes — Cheat Sheet

### Surfaces
| Class | Use |
|-------|-----|
| `.card` | Standard surface card |
| `.card-lg` | Larger padding card |
| `.card-success/warning/danger/info/accent` | Status-tinted card |
| `.glass` | Frosted glass (dark mode) |

### Grids
| Class | Use |
|-------|-----|
| `.grid.grid-2` | 2-column |
| `.grid.grid-3` | 3-column |
| `.grid.grid-4` | 4-column |
| `.grid.grid-auto` | Auto-fill, min 240px |

### Status
| Class | Use |
|-------|-----|
| `.badge-accent/success/warning/danger/info/default` | Status badges |
| `.badge.pill` | Rounded pill shape |
| `.badge.with-dot` | Adds a status dot |
| `.alert-success/warning/danger/info/accent` | Alert / notice box |

### Data
| Class | Use |
|-------|-----|
| `.table-wrap > table.sulla-table` | Styled table with scroll |
| `.meta-grid > .meta-key + .meta-val` | Key-value metadata |
| `.stat > .stat-label + .stat-value + .stat-delta` | KPI stat block |
| `.progress-bar > .progress-fill` | Progress bar |
| `.checklist` with `li.done / li.in-progress` | Checklist |

### Narrative
| Class | Use |
|-------|-----|
| `.timeline > .timeline-item.done/.active/.blocked` | Timeline |
| `.terminal > .terminal-bar + .terminal-body` | Terminal block |
| `.section > .section-header > .section-title + .section-rule` | Labeled section |
| `.page-hero` | Page title + subtitle |
| `.divider` | Labeled divider line |

### Buttons
| Class | Use |
|-------|-----|
| `.btn.btn-primary` | Steel blue fill |
| `.btn.btn-ghost` | Outline/transparent |
| `.btn.btn-outline-accent` | Accent outline |
| `.btn-sm`, `.btn-xs` | Size variants |

---

## Relative Path from `~/sulla/projects/`

Projects live at `~/sulla/projects/<project-name>/`. The CSS is at `~/sulla/designs/sulla.css`.

From a project file two levels deep (`~/sulla/projects/my-project/doc.html`):
```html
<link rel="stylesheet" href="../../designs/sulla.css">
```

From a project file one level deep (`~/sulla/projects/doc.html`):
```html
<link rel="stylesheet" href="../designs/sulla.css">
```

---

## Updating the Design System

The canonical source lives in **two places that must stay in sync**:

1. `<app-resources>/design-system/sulla.css` — ships with the app (committed to repo)
2. `~/sulla/designs/sulla.css` — user's local copy

When making design changes, edit both files (or copy one to the other). The repo version ships to all new installations; the local version is what running HTML files actually load.
