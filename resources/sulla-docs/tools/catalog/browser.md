# browser tools

Open/close tabs, read page content, click + fill forms, screenshot, exec JS, inspect cookies/history, background browsing, and desktop notifications. Open returns the page snapshot inline so you do not need a second call.

## agent_storage

Persistent key-value store for agent state that survives across conversations. Store task progress, discovered user preferences, cached API responses, or any structured data.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `action` | enum: get\|set\|remove | Required |
| `keys` | string | Optional |
| `data` | object | Optional |

**Example**

```bash
sulla browser/agent_storage '{"action":"<action>"}'
```

## background_browse

Browse the web in a hidden tab without disrupting the user's visible browser. Open pages, read content, capture screenshots, navigate, and close — all in the background.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `action` | enum: open\|read\|navigate\|screenshot\|close\|list | Required |
| `url` | string | Optional |
| `tabId` | string | Optional |
| `waitMs` | number | Optional |
| `code` | string | Optional |

**Example**

```bash
sulla browser/background_browse '{"action":"<action>"}'
```

## click

Click a button, link, or interactive element by handle. Handles come from the snapshot returned by browser/tab (upsert) or browser/snapshot — e.g. @btn-save, @link-home.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `handle` | string | Required |
| `assetId` | string | Optional |

**Example**

```bash
sulla browser/click '{"handle":"<handle>"}'
```

## click_at

Click at pixel coordinates using trusted mouse events. Use `browser/screenshot` first to identify coordinates (grid on by default).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `x` | number | Required |
| `y` | number | Required |
| `button` | enum: left\|right\|middle | Optional |
| `double_click` | boolean | Optional |
| `assetId` | string | Optional |

**Example**

```bash
sulla browser/click_at '{"x":"<x>","y":"<y>"}'
```

## controller

Graph-bound delegation to Sulla Desktop's in-app Browser for capability-enabled scheduled graphs. Read the installed Browser skill safety rules and bundled tools/browser.md first, then pass one browser operation plus its documented arguments.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `tool` | enum: tab\|snapshot\|text\|form\|screenshot\|click\|fill\|press_key\|scroll\|wait\|click_at\|type_at\|hover\|eval_js | Required |
| `args` | object | Optional |

**Example**

```bash
sulla browser/controller '{"tool":"<tool>"}'
```

## eval_js

Evaluate arbitrary JavaScript in the active browser tab with enhanced diagnostics. A single expression is auto-returned like a devtools console (`document.title` works as-is); multi-statement code must use an explicit `return` to send a value back.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `code` | string | Required |
| `screenshot` | boolean | Optional |
| `waitFor` | string | Optional |
| `waitForIdle` | boolean | Optional |
| `timeout` | number | Optional |
| `assetId` | string | Optional |

**Example**

```bash
sulla browser/eval_js '{"code":"<code>"}'
```

## fill

Set the value of a form field (input, textarea, select). If submit=true, presses Enter after to submit the form; if that triggers navigation, returns the full new page state.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `handle` | string | Required |
| `value` | string | Required |
| `submit` | boolean | Optional |
| `assetId` | string | Optional |

**Example**

```bash
sulla browser/fill '{"handle":"<handle>","value":"<value>"}'
```

## form

Get a map of all visible form field values (inputs, textareas, selects) from a tab.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `assetId` | string | Optional |

**Example**

```bash
sulla browser/form '{}'
```

## hover

Move the mouse to coordinates without clicking. Triggers hover effects, dropdown menus, and tooltips.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `x` | number | Required |
| `y` | number | Required |
| `assetId` | string | Optional |

**Example**

```bash
sulla browser/hover '{"x":"<x>","y":"<y>"}'
```

## list

List all open browser tabs with their assetId, URL, title, and status (ready/loading).

**Parameters**

None.

**Example**

```bash
sulla browser/list '{}'
```

## manage_cookies

Read, set, or delete browser cookies. Use to debug auth issues, check login state, inspect session tokens, or manage cookies across integrated services (Twenty CRM, N8N, etc.).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `action` | enum: get\|getAll\|set\|remove | Required |
| `url` | string | Optional |
| `name` | string | Optional |
| `value` | string | Optional |
| `domain` | string | Optional |
| `path` | string | Optional |
| `secure` | boolean | Optional |
| `httpOnly` | boolean | Optional |
| `expirationDate` | number | Optional |

**Example**

```bash
sulla browser/manage_cookies '{"action":"<action>"}'
```

## modify_history

Add, delete, or clear browsing history entries. Use to record researched URLs, remove sensitive entries, or clear history for privacy.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `action` | enum: add\|delete\|deleteAll | Required |
| `url` | string | Optional |
| `title` | string | Optional |

**Example**

```bash
sulla browser/modify_history '{"action":"<action>"}'
```

## monitor_network

Monitor network requests for a duration. Capture all requests (with status codes) or watch for errors/failures.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `action` | enum: capture\|watch_errors | Required |
| `durationSeconds` | number | Optional |
| `urlFilter` | string | Optional |

**Example**

```bash
sulla browser/monitor_network '{"action":"<action>"}'
```

## press_key

Press a key. Use for form submission (Enter), closing dialogs (Escape), navigating dropdowns (ArrowDown/ArrowUp), or tabbing between fields (Tab).

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `key` | string | Required |
| `handle` | string | Optional |
| `assetId` | string | Optional |

**Example**

```bash
sulla browser/press_key '{"key":"<key>"}'
```

## schedule_alarm

Set, list, or clear named timers. Use for deferred checks ("check the deploy in 5 minutes"), periodic polling, or simple reminders.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `action` | enum: create\|get\|list\|clear\|clearAll | Required |
| `name` | string | Optional |
| `delayInMinutes` | number | Optional |
| `periodInMinutes` | number | Optional |
| `when` | number | Optional |

**Example**

```bash
sulla browser/schedule_alarm '{"action":"<action>"}'
```

## screenshot

Capture a visual screenshot of a tab. Image is saved to disk and the response returns a compact `{ screenshot: { assetId, path, width, height, bytes } }` reference — never inline base64.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `assetId` | string | Optional |
| `grid` | boolean | Optional |
| `annotate` | boolean | Optional |

**Example**

```bash
sulla browser/screenshot '{}'
```

## scroll

Scroll a matching element into view using a CSS selector.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `selector` | string | Required |
| `assetId` | string | Optional |

**Example**

```bash
sulla browser/scroll '{"selector":"<selector>"}'
```

## search_conversations

Search past chat conversations, browser visits, and workflow executions. Find previous discussions by keyword, list recent activity, retrieve details, or read the full transcript of a past conversation.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `action` | enum: search\|recent\|get\|messages | Required |
| `query` | string | Optional |
| `limit` | number | Optional |
| `type` | enum: chat\|browser\|workflow\|graph | Optional |
| `id` | string | Optional |
| `threadId` | string | Optional |

**Example**

```bash
sulla browser/search_conversations '{"action":"<action>"}'
```

## search_history

Search the user's browsing history by text query and/or time range. Find pages visited previously, check when a site was last accessed, or recall URLs the user looked at earlier.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `query` | string | Optional |
| `maxResults` | number | Optional |
| `startTime` | number | Optional |
| `endTime` | number | Optional |

**Example**

```bash
sulla browser/search_history '{}'
```

## snapshot

Re-read page state for an already-open tab. Default "dehydrated" mode returns a compressed DOM tree (~5k tokens) with interactive-element handles — ideal for planning. "full" mode adds reader-mode text and scroll position.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `assetId` | string | Optional |
| `mode` | enum: full\|dehydrated | Optional |

**Example**

```bash
sulla browser/snapshot '{}'
```

## tab

Open, navigate, or close a browser tab. When opening/navigating (action=upsert), the response already includes a dehydrated DOM snapshot of the loaded page — title, URL, interactive elements, and a summary — so you do NOT need to call `browser/snapshot` separately afterwards.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `action` | enum: upsert\|remove | Required |
| `assetType` | enum: browser\|iframe\|document | Optional |
| `assetId` | string | Optional |
| `skillSlug` | string | Optional |
| `title` | string | Optional |
| `url` | string | Optional |
| `content` | string | Optional |
| `active` | boolean | Optional |
| `collapsed` | boolean | Optional |
| `refKey` | string | Optional |

**Example**

```bash
sulla browser/tab '{"action":"<action>"}'
```

## text

Get the readable text content of a tab with title, URL, and scroll position. Uses reader-mode extraction (strips nav, ads, boilerplate) with fallback to raw text.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `assetId` | string | Optional |

**Example**

```bash
sulla browser/text '{}'
```

## type_at

Click at coordinates to focus an element, then type text using trusted keyboard events. After typing, captures a screenshot.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `x` | number | Required |
| `y` | number | Required |
| `text` | string | Required |
| `submit` | boolean | Optional |
| `assetId` | string | Optional |

**Example**

```bash
sulla browser/type_at '{"x":"<x>","y":"<y>","text":"<text>"}'
```

## wait

Wait for a CSS selector to become visible. Useful after clicking a button to wait for new content to appear.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `selector` | string | Required |
| `timeout` | number | Optional |
| `assetId` | string | Optional |

**Example**

```bash
sulla browser/wait '{"selector":"<selector>"}'
```
