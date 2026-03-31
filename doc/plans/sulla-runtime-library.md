# `window.__sulla` Runtime Library — Implementation Plan

## Overview

Inject a lightweight helper library (`window.__sulla`) into every page alongside `sullaBridge`. This gives the AI agent debugged, composable, observable functions it can call directly via `exec_in_page` — reducing multi-step workflows from 15+ tool calls to 2-3 `exec_in_page` calls.

## Motivation

| Problem | How `__sulla` solves it |
|---------|------------------------|
| Simple workflows require 10-15 sequential tool calls | `__sulla.steps()` composes multiple actions in one round-trip |
| Agent writes raw JS for every interaction — fragile, verbose | Pre-built helpers like `__sulla.click()`, `__sulla.fill()` are debugged and reliable |
| No visibility into what failed during `exec_in_page` | `__sulla.__log` captures every helper call with timing, success/failure, fallback used |
| Full page snapshots waste tokens on complex pages | `__sulla.dehydrate()` compresses DOM to ~5k tokens of actionable structure |
| Click failures require agent to guess a recovery strategy | Built-in retry chain: handle → selector → coordinates, with structured failure reporting |
| No way to batch bridge operations | `__sulla.steps()` runs N operations in one IPC round-trip |

## Design Principles

- **Simple**: <5KB, ES5-compatible, zero external dependencies
- **Fast**: All functions run in-page, no IPC round-trips for helpers
- **Observable**: Every call logged to `__sulla.__log` with timing + result
- **Composable**: `steps()` and `retry()` let the AI chain operations
- **Non-breaking**: Existing tools unchanged — `__sulla` is additive

## Current State

| Layer | Status | What exists |
|-------|--------|-------------|
| `window.sullaBridge` | Complete | 15+ IPC methods for host↔guest communication |
| `exec_in_page` tool | Complete | Arbitrary JS execution with console capture |
| `get_page_snapshot` | Complete | Actionable markdown with `@handle` system |
| `GuestBridgePreload` | Complete | Injection lifecycle, guard flag, READY state |
| `take_screenshot` | Complete | JPEG capture with grid overlay + element annotation |
| DOM event streaming | Complete | MutationObserver, route changes, click tracking |
| `window.__sulla` | **Not started** | — |

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │              Page Context                │
                    │                                          │
                    │  window.sullaBridge  ← IPC bridge (exists)
                    │  window.__sulla      ← helper library (new)
                    │                                          │
                    │  __sulla uses DOM APIs directly          │
                    │  __sulla.__log captures all calls        │
                    └──────────────┬───────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────┐
                    │         exec_in_page (enhanced)          │
                    │                                          │
                    │  Wraps code + captures:                  │
                    │  - result / error / console logs         │
                    │  - __sulla.__log (new)                   │
                    │  - timing, mutations, navigated (new)    │
                    │  - optional screenshot (new)             │
                    └──────────────┬───────────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────────┐
                    │         Agent / LLM                      │
                    │                                          │
                    │  Sees structured result + full log       │
                    │  Knows exactly what worked / failed      │
                    │  Decides next action with full context   │
                    └──────────────────────────────────────────┘
```

## Relationship to Existing Tools

`__sulla` does **not** replace existing Playwright tools. They serve different use cases:

| Use case | Use this |
|----------|----------|
| Open / close a tab | `browser_tab` tool |
| Simple single click | `click_element` tool |
| Read page content | `browse_page` tool |
| Multi-step workflow (search → click → extract) | `exec_in_page` + `__sulla.steps()` |
| Complex data extraction | `exec_in_page` + `__sulla.text/table/forms` |
| Debug why something failed | Read `sullaLog` from enhanced `exec_in_page` |
| Get compressed page overview for planning | `get_page_snapshot(mode: "dehydrated")` or `__sulla.dehydrate()` |

---

## Phase 1: `window.__sulla` Runtime Library

**File**: `pkg/rancher-desktop/agent/scripts/injected/SullaRuntime.ts`
**Injected by**: `GuestBridgePreload.ts` — alongside `sullaBridge` in the same `dom-ready` lifecycle
**Guard**: `window.__sullaRuntimeInjected` flag (same pattern as bridge)
**Size target**: <5KB minified

### 1.1 DOM Queries

Return metadata, not just elements. The AI needs to reason about what it found.

```js
__sulla.$(sel)
// → { el, text, tag, rect, visible, attrs, handle } or null

__sulla.$$(sel)
// → array of above

__sulla.closest(startSel, ancestorSel)
// → nearest ancestor matching ancestorSel
```

- `rect` = `getBoundingClientRect()` as plain object
- `visible` = computed display/visibility/opacity check (reuse existing `isVisible()` from bridge)
- `handle` = `data-sulla-handle` value if stamped
- `text` = `innerText` truncated to 200 chars

### 1.2 Wait Functions

Promise-based. No polling loops. Use MutationObserver internally.

```js
__sulla.waitFor(sel, timeout?)
// → resolves with element metadata when selector matches a visible element
// Default timeout: 10000ms

__sulla.waitForText(text, timeout?)
// → resolves when text appears anywhere in document.body.innerText

__sulla.waitForGone(sel, timeout?)
// → resolves when selector no longer matches any visible element

__sulla.waitForIdle(timeout?)
// → resolves when: no pending fetches + no DOM mutations for 500ms
// Uses PerformanceObserver for network, MutationObserver for DOM
```

All reject with `{ error: "timeout", waited: ms, selector }` on timeout.

### 1.3 Interact Functions

Each has a built-in retry/fallback chain.

```js
__sulla.click(target)
// Fallback chain:
//   1. data-sulla-handle lookup (if target starts with @)
//   2. CSS selector querySelector
//   3. Get bounding rect → coordinate click via dispatchEvent
//   4. Return { ok: false, reason, suggestion }

__sulla.fill(target, value)
// → focus element → select all → delete → type value char-by-char
// Dispatches: focus, input, change events
// Works with React/Vue controlled inputs (native event dispatch)

__sulla.select(target, value)
// → set <select> value + dispatch change event

__sulla.submit(formSel?)
// → find nearest <form> from current focus or formSel, call submit()
// Falls back to clicking first submit button in form

__sulla.press(key, target?)
// → dispatch keydown + keyup on target or document
// Supports: Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Backspace, Space

__sulla.hover(target)
// → dispatch mouseenter + mouseover events
// Useful for revealing tooltips, dropdown menus
```

### 1.4 Scroll

```js
__sulla.scrollTo(sel)
// → scrollIntoView({ behavior: 'smooth', block: 'center' })

__sulla.scrollBy(px, container?)
// → scroll container (or window) by px pixels vertically

__sulla.scrollInfo(container?)
// → { top, height, viewportHeight, pct, atBottom, atTop }
```

### 1.5 Extract

```js
__sulla.text(sel)
// → innerText of first match, trimmed

__sulla.table(sel)
// → parse <table> into array of row objects using <th> as keys
// Example: [{ "Name": "Acme", "Price": "$10" }, ...]

__sulla.forms()
// → all forms on page with field names, values, types, required flags

__sulla.attrs(sel, ...names)
// → { attrName: value } for requested attributes

__sulla.rect(sel)
// → { x, y, width, height, top, right, bottom, left }
```

### 1.6 Dehydrate (DOM Compression)

```js
__sulla.dehydrate(opts?)
// opts: { maxTokens: 5000, interactiveOnly: false, includeText: true }
//
// Returns: {
//   tree: string,          // compressed DOM text
//   stats: { tokens, interactiveCount, textNodes, depth }
// }
```

**Algorithm**:
1. Walk `<body>` depth-first
2. **Skip**: hidden elements, `<script>`, `<style>`, `<noscript>`, `<svg>`, empty containers with no interactive children, elements with `aria-hidden="true"`
3. **Collapse**: chains of single-child `<div>`/`<span>` into parent
4. **Keep**: interactive elements (with `@handle`), text nodes >2 chars, landmarks (`<nav>`, `<main>`, `<header>`, `<footer>`, `<aside>`), headings, lists, tables, `<form>`
5. **Output per node**: `indent + tag + [handle|id] + "visible text" + {interactive: bool}`
6. **Truncate**: Stop emitting when token estimate exceeds `maxTokens`, append `[... truncated, N more nodes]`

**Output example**:
```
main
  nav
    a @link-home "Home"
    a @link-products "Products"
    a @link-cart "Cart (3)"
  section
    h1 "Summer Sale — 40% Off"
    div.product-grid
      article @item-product-1 "Nike Air Max — $89"
        button @btn-add-to-cart "Add to Cart"
      article @item-product-2 "Adidas Ultra — $120"
        button @btn-add-to-cart-2 "Add to Cart"
  form
    input @field-q type=search placeholder="Search..."
    button @btn-search "Go"
```

### 1.7 Visual Debug

```js
__sulla.highlight(sel, color?)
// → overlay semi-transparent bounding box on matched elements
// Default color: rgba(255, 0, 0, 0.3)
// Returns count of highlighted elements

__sulla.clearHighlights()
// → remove all highlight overlays
```

### 1.8 Compose

```js
__sulla.steps(fns)
// → execute array of async functions sequentially
// Returns array of results, stops on first error
// Example:
//   __sulla.steps([
//     () => __sulla.fill('@field-q', 'coffee shops'),
//     () => __sulla.press('Enter'),
//     () => __sulla.waitFor('[role="feed"]'),
//     () => __sulla.click('[role="feed"] a'),
//   ])

__sulla.retry(fn, attempts?, delay?)
// → retry fn up to N times (default 3) with delay between (default 1000ms)
// Returns result of first successful call
// On final failure, returns { ok: false, attempts, lastError }
```

### 1.9 Internal Logging

Every `__sulla` function logs to `__sulla.__log`:

```js
__sulla.__log = [
  { fn: "fill", args: ["@field-q", "coffee shops"], ok: true, ms: 23 },
  { fn: "press", args: ["Enter"], ok: true, ms: 5 },
  { fn: "waitFor", args: ["[role='feed']"], ok: true, ms: 1842 },
  { fn: "click", args: ["[role='feed'] a"], ok: true, ms: 38, fallback: null },
]
```

Fields per entry:
- `fn` — function name
- `args` — arguments passed (values truncated to 100 chars)
- `ok` — success or failure
- `ms` — execution time
- `error` — error message if `ok: false`
- `fallback` — which fallback was used (for `click`/`fill`: `null`, `"selector"`, `"coords"`)

Log is **cleared on each `exec_in_page` call** (fresh log per execution).

---

## Phase 2: Enhanced `exec_in_page` Tool

**File**: `pkg/rancher-desktop/agent/tools/playwright/exec_in_page.ts`

### 2.1 New Optional Parameters

```
code:         string   (required — unchanged)
assetId:      string   (optional — unchanged)
screenshot:   boolean  (optional, default false) — capture JPEG after execution
waitFor:      string   (optional) — CSS selector to wait for after code runs
waitForIdle:  boolean  (optional, default false) — wait for network+DOM idle after code
timeout:      number   (optional, default 30000) — max execution time in ms
```

### 2.2 Enhanced Return Value

```
result:          any       — code return value (unchanged)
error:           string    — error message if thrown (unchanged)
logs:            string[]  — console output, cap raised to 100 lines (was 50)
sullaLog:        object[]  — __sulla.__log entries from this execution (new)
timing:          number    — total execution time in ms (new)
mutations:       number    — DOM mutation count during execution (new)
navigated:       boolean   — did URL change during execution? (new)
url:             string    — current page URL after execution (new)
title:           string    — current page title after execution (new)
screenshotBase64: string   — JPEG base64 if screenshot: true (new)
```

### 2.3 Implementation Changes

**Before code executes**:
- Clear `__sulla.__log` → `window.__sulla.__log = []`
- Record `location.href` for navigation detection
- Start MutationObserver counting changes
- Record `performance.now()` for timing

**After code executes**:
- Stop MutationObserver, record count
- Compare `location.href` for navigation detection
- Read `window.__sulla.__log`
- If `waitFor` specified: await `__sulla.waitFor(sel)`
- If `waitForIdle` specified: await `__sulla.waitForIdle()`
- If `screenshot` specified: capture via existing screenshot mechanism
- Return enhanced result object

### 2.4 Manifest Update

**File**: `pkg/rancher-desktop/agent/tools/playwright/manifests.ts`

Update `exec_in_page` schema to include new optional parameters. Add descriptions explaining when to use each.

---

## Phase 3: DOM Dehydration on `get_page_snapshot`

**File**: `pkg/rancher-desktop/agent/tools/playwright/get_page_snapshot.ts`

### 3.1 New Parameter

```
mode: "full" | "dehydrated"   (optional, default "full")
```

- `"full"` — current behavior (actionable markdown + reader content)
- `"dehydrated"` — calls `__sulla.dehydrate()` via bridge, returns compressed tree + stats

### 3.2 Dehydrated Response Format

```
[asset: tab-1]
# Dehydrated DOM — example.com/products
**URL**: https://example.com/products
**Stats**: 847 tokens | 12 interactive | 34 text nodes | depth 8

main
  nav
    a @link-home "Home"
    a @link-products "Products" [active]
    ...
  section
    h1 "All Products"
    ...
```

### 3.3 When to Use Which Mode

Include guidance in the tool description:
- Use `"full"` when you need complete page content for reading/research
- Use `"dehydrated"` when you need to understand page structure for planning actions
- Dehydrated mode is 5-10x fewer tokens — prefer it for action planning

---

## Phase 4: System Prompt Integration + Logging + Approval Groundwork

### 4.1 System Prompt Update

**File**: `pkg/rancher-desktop/agent/prompts/` (browser context section)

Add documentation teaching the agent:

```markdown
## Using `exec_in_page` with `__sulla` Helpers

When performing multi-step browser workflows, use `exec_in_page` with `__sulla`
helpers instead of calling individual tools. This reduces round-trips and gives
you structured logging.

### When to use __sulla vs individual tools
- Opening/closing tabs → use `browser_tab`
- Single click or field fill → use `click_element` or `set_field`
- Reading page content → use `browse_page`
- Multi-step workflow → use `exec_in_page` + `__sulla.steps()`
- Data extraction → use `exec_in_page` + `__sulla.text/table/forms`
- Understanding page structure → use `get_page_snapshot(mode: "dehydrated")`

### Reading the sullaLog
After each exec_in_page call, check `sullaLog` to understand what happened:
- Every __sulla function call is logged with timing and success/failure
- If `ok: false`, the `error` field explains why
- The `fallback` field on click/fill shows which resolution strategy worked

### Common Patterns

Search + click result:
  __sulla.steps([
    () => __sulla.fill('@field-search', 'query'),
    () => __sulla.press('Enter'),
    () => __sulla.waitFor('.results'),
    () => __sulla.click('.results a'),
  ])

Extract structured data:
  return {
    title: __sulla.text('h1'),
    items: __sulla.table('.data-table'),
    forms: __sulla.forms(),
  }

Plan actions from compressed DOM:
  return __sulla.dehydrate({ maxTokens: 3000 })
```

### 4.2 Console Logging Enhancement

The existing console capture in `exec_in_page` already works. Enhancements:
- Raise log line cap from 50 → 100
- Add `__sulla.__log` as separate `sullaLog` field (structured, not string)
- On error, include the last 5 `__sulla.__log` entries in the error message for immediate context

### 4.3 Approval Gates Groundwork

**File**: `pkg/rancher-desktop/agent/tools/playwright/manifests.ts`

Add `risk` field to every tool manifest:

| Tool | Risk |
|------|------|
| `list_tabs`, `get_page_snapshot`, `get_page_text`, `browse_page`, `get_form_values`, `synthesize_tabs`, `take_screenshot` | `"read"` |
| `browser_tab`, `click_element`, `set_field`, `press_key`, `click_at`, `type_at`, `scroll_to_element`, `move_mouse`, `wait_for_element` | `"mutation"` |
| `exec_in_page` | `"execute"` |

**File**: `pkg/rancher-desktop/agent/nodes/BaseNode.ts`

Add a hook point in tool execution:

```typescript
// Before executing a tool with risk != "read":
// if (tool.risk === 'mutation' || tool.risk === 'execute') {
//   await this.onBeforeMutation?.(tool, args);
// }
```

This is a no-op initially — just the wiring. The actual approval UI and trigger-word detection (`buy`, `delete`, `submit`, `pay`, `send`) will be built when we're ready to ship that feature.

---

## Execution Order

```
Phase 1  →  SullaRuntime.ts + injection in GuestBridgePreload.ts
Phase 2  →  Enhanced exec_in_page (depends on Phase 1 being injectable)
Phase 3  →  Dehydrate mode on get_page_snapshot (depends on Phase 1 for __sulla.dehydrate)
Phase 4  →  Prompts + logging + approval wiring (depends on Phases 1-3 existing)
```

Phases 1 + 2 should ship together — the runtime without enhanced exec loses observability.
Phase 3 can ship independently after Phase 1.
Phase 4 is the integration glue — ship last.

---

## Example: Before vs After

### Before: Google Maps Business Lookup (15 tool calls)

```
1.  browser_tab(url: "https://maps.google.com")
2.  get_page_snapshot()
3.  set_field(@field-q, "best coffee Portland")
4.  press_key(Enter)
5.  wait_for_element([role="feed"])
6.  get_page_snapshot()
7.  click_element([role="feed"] a)
8.  wait_for_element(h1)
9.  get_page_snapshot()
10. browse_page(action: read)
11. click_element(@btn-reviews)
12. wait_for_element(.review-list)
13. browse_page(action: read)
14. take_screenshot()
15. browser_tab(action: remove)
```

### After: Same Task (4 calls)

```
1.  browser_tab(url: "https://maps.google.com")

2.  exec_in_page(screenshot: true, waitForIdle: true, code: `
      return await __sulla.steps([
        () => __sulla.fill('[name="q"]', 'best coffee Portland'),
        () => __sulla.press('Enter'),
        () => __sulla.waitFor('[role="feed"] a'),
        () => __sulla.click('[role="feed"] a'),
        () => __sulla.waitForIdle(),
      ]);
    `)

3.  exec_in_page(code: `
      return {
        name:    __sulla.text('h1'),
        rating:  __sulla.text('[role="img"][aria-label*="stars"]'),
        address: __sulla.text('[data-item-id="address"]'),
        phone:   __sulla.text('[data-item-id="phone"]'),
        hours:   __sulla.text('[aria-label*="hours"]'),
      };
    `)

4.  browser_tab(action: "remove")
```

**Result**: 4 calls instead of 15. Full `sullaLog` on each call. Screenshot included. Same data extracted.

---

## What NOT to Build

- **Recipe/template system** — the LLM writes better JS than templates could cover
- **New sub-commands on exec_in_page** — keep it one flexible tool with options
- **Large framework injection** — stay under 5KB, ES5, no deps
- **Cross-browser support** — Chrome/Electron is the platform
- **Headless/cloud scaling** — sulla-desktop is a desktop app
- **Benchmarking suite** — test on real sites, not academic benchmarks
- **Deprecate existing tools** — they're good for simple one-shot operations

---

## Files to Create / Modify

| Action | File | Phase |
|--------|------|-------|
| **Create** | `pkg/rancher-desktop/agent/scripts/injected/SullaRuntime.ts` | 1 |
| **Modify** | `pkg/rancher-desktop/agent/scripts/injected/GuestBridgePreload.ts` | 1 |
| **Modify** | `pkg/rancher-desktop/agent/tools/playwright/exec_in_page.ts` | 2 |
| **Modify** | `pkg/rancher-desktop/agent/tools/playwright/manifests.ts` | 2, 4 |
| **Modify** | `pkg/rancher-desktop/agent/tools/playwright/get_page_snapshot.ts` | 3 |
| **Modify** | `pkg/rancher-desktop/agent/prompts/` (browser context) | 4 |
| **Modify** | `pkg/rancher-desktop/agent/nodes/BaseNode.ts` | 4 |

## References

- [Alibaba PageAgent](https://github.com/alibaba/page-agent) — DOM dehydration, text-only reasoning, BYOLLM
- [PinchTab](https://github.com/pinchtab/pinchtab) — stable element refs, structured text returns
- [Browser Use](https://github.com/browser-use/browser-use) — JS execution + screenshots, composition patterns
- [Playwright MCP](https://github.com/anthropics/playwright-mcp) — pre-injected runtime, structured metadata
- [rtrvr.ai](https://rtrvr.ai) — DOM Intelligence, semantic tree traversal
- [ApexAgent](https://github.com/RTBRuhan/ApexAgent) — MCP exposure, full browser control
