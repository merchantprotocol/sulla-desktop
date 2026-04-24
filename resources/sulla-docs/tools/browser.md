# Browser Tools

The richest tool surface in Sulla. ~28 tools for tabs, page reading, interaction, JS evaluation, cookies, history, network monitoring, and persistent agent storage. **All tools target Sulla's built-in WebContentsViews — not the user's external browser.**

## Two paradigms — pick the right one

1. **Handle-based** (preferred): use `snapshot` to get a dehydrated DOM with handles like `@btn-submit`, `@field-email`, `@link-home`. Pass those handles into `click`, `fill`, `press_key`. Reliable across re-renders.
2. **Coordinate-based** (fallback): when handles fail (shadow DOM, iframes, custom canvas widgets), use `screenshot` to see pixel coords, then `click_at` / `type_at` / `hover` at (x, y). Trusted CDP events.

Default to handle-based. Drop to coordinates only when the snapshot can't see the element.

## Asset IDs and tab scoping

Tabs are addressed by `assetId`, **not** `tabId`. AssetIds are scoped by the agent's thread so parallel agents don't collide. If you don't pass one, it's auto-derived from the URL domain. Most tools accept omitting `assetId` to mean "the active tab."

## window.__sulla — the in-page bridge

On every page, the guest preload injects `window.__sulla`. It exposes:
- `__sulla.dehydrate(opts)` → `{ tree, stats }` — what `snapshot` returns
- `__sulla.waitFor(selector)` — promise that resolves when selector is visible
- `__sulla.waitForIdle()` — promise that resolves when DOM stops mutating
- `__sulla.__log` — diagnostic log array (cleared at each `eval_js` start)

A 0-token snapshot does **not** mean the runtime is missing — that bug was fixed. If snapshot returns nothing, re-call it.

---

## Tab management

### `browser/tab` — open / navigate / close
**Actions:** `upsert` (open or navigate) and `remove` (close). Anything else (including `open`) silently aliases to upsert.

```bash
sulla browser/tab '{"action":"upsert","url":"https://example.com","assetId":"my-tab"}'
sulla browser/tab '{"action":"remove","assetId":"my-tab"}'
```

The `upsert` response **includes a dehydrated snapshot inline** — no separate snapshot call needed after open/navigate.

### `browser/list` — show open tabs
```bash
sulla browser/list '{}'
```
Returns markdown list of tabs with `assetId`, URL, title, loading status, active marker.

---

## Reading the page

### `browser/snapshot` — dehydrated DOM (the agent's primary lens)
```bash
sulla browser/snapshot '{"assetId":"my-tab"}'
sulla browser/snapshot '{"assetId":"my-tab","mode":"full"}'   # add reader text + scroll pos
```
Returns ~5k-token compressed tree with handles for every interactive element. Handles look like `@btn-submit`, `@link-home`, `@field-email`. **Those handles flow directly into `click`, `fill`, `press_key`, etc.**

Use this after every interaction to confirm the page state changed as expected.

### `browser/text` — reader-mode text content
```bash
sulla browser/text '{"assetId":"my-tab"}'
```
Strips nav/ads/boilerplate. Includes title, URL, scroll position. Falls back to raw `innerText` if reader mode fails.

### `browser/form` — current form field values
```bash
sulla browser/form '{"assetId":"my-tab"}'
```
Returns `{ fieldName: currentValue, ... }` for every visible input/textarea/select. Useful before filling — see what's already there.

### `browser/screenshot` — capture image to disk
```bash
sulla browser/screenshot '{"assetId":"my-tab"}'
sulla browser/screenshot '{"assetId":"my-tab","grid":false,"annotate":true}'
```
**Saves to `~/sulla/artifacts/screenshots/<assetId>.jpg`** (auto-pruned after 24h). Returns:
```json
{ "screenshot": { "assetId":"...", "path":"...", "width":..., "height":..., "bytes":..., "mediaType":"image/jpeg", "capturedAt":"..." } }
```
**Not inline base64** — load the path with the `Read` tool to put the image into vision context.

Options:
- `grid` (default `true`) — overlay a labeled coordinate grid (200px step). Removed after capture. Useful for picking coords for `click_at`.
- `annotate` (default `false`) — draw numbered boxes around interactive elements.

**Race note:** if you call `screenshot` immediately after `tab` upsert, retry up to 4× at 400ms intervals — Chromium may have no compositor frame yet.

### `browser/readability-extract` — full reader-mode HTML/MD extraction
```bash
sulla browser/readability-extract '{"assetId":"my-tab"}'
```
Heavier than `text`; returns structured Mozilla Readability output.

---

## Handle-based interaction (preferred)

### `browser/click`
```bash
sulla browser/click '{"assetId":"my-tab","handle":"@btn-submit"}'
sulla browser/click '{"assetId":"my-tab","handle":"button.primary"}'   # CSS fallback
```
If the click triggers navigation, returns the **full dehydrated DOM of the new page**.

### `browser/fill`
```bash
sulla browser/fill '{"assetId":"my-tab","handle":"@field-email","value":"x@y.com"}'
sulla browser/fill '{"assetId":"my-tab","handle":"@field-q","value":"...","submit":true}'
```
`submit: true` presses Enter after fill. If submission triggers navigation, returns the new page's dehydrated DOM.

### `browser/press_key`
```bash
sulla browser/press_key '{"assetId":"my-tab","key":"Enter"}'
sulla browser/press_key '{"assetId":"my-tab","key":"Escape","handle":"@dialog"}'
```
Supported keys: `Enter`, `Escape`, `Tab`, `Backspace`, `Space`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`. Omit `handle` to fire on the focused element.

### `browser/scroll` — scroll element into view
```bash
sulla browser/scroll '{"assetId":"my-tab","selector":".footer"}'
```
CSS selector, not handle.

### `browser/wait` — wait for selector to appear
```bash
sulla browser/wait '{"assetId":"my-tab","selector":".results-loaded","timeout":5000}'
```
Returns updated page state once visible.

### `browser/hover`
```bash
sulla browser/hover '{"assetId":"my-tab","x":450,"y":320}'
```
Coord-based — triggers `:hover` effects, dropdowns, tooltips. Returns a screenshot showing the cursor.

---

## Coordinate-based interaction (fallback)

Use when handles fail. Get coords by reading a screenshot (with grid overlay).

### `browser/click_at`
```bash
sulla browser/click_at '{"assetId":"my-tab","x":450,"y":320}'
sulla browser/click_at '{"assetId":"my-tab","x":450,"y":320,"button":"right","double_click":false}'
```
Trusted CDP mouse event. Injects a visible cursor animation; the screenshot in the response shows where the click landed.

### `browser/type_at`
```bash
sulla browser/type_at '{"assetId":"my-tab","x":300,"y":200,"text":"hello world"}'
sulla browser/type_at '{"assetId":"my-tab","x":300,"y":200,"text":"query","submit":true}'
```
Clicks (x,y) to focus, then types char-by-char via CDP keyboard events. Useful for chat widgets, shadow-DOM inputs.

---

## JavaScript escape hatch

### `browser/eval_js` — run arbitrary JS
```bash
sulla browser/eval_js '{"assetId":"my-tab","code":"return document.title"}'
sulla browser/eval_js '{"assetId":"my-tab","code":"...","screenshot":true,"waitForIdle":true}'
```
Returns:
```json
{
  "result":     ...,                      // serialized return value
  "error":      "...", "errorStack": "...", // if code threw
  "logs":       [...],                    // console.log/warn/error
  "sullaLog":   [...],                    // window.__sulla.__log entries
  "timing":     1234,                     // ms
  "mutations":  N,                        // DOM mutation count
  "navigated":  false,                    // did URL change?
  "url":        "...", "title": "...",
  "screenshot": { ... }                   // if requested
}
```
Options: `waitFor` (CSS selector), `waitForIdle` (bool), `timeout` (ms, default 30000), `screenshot` (bool).

---

## Cookies, history, storage

### `browser/manage_cookies`
```bash
sulla browser/manage_cookies '{"action":"getAll","assetId":"my-tab"}'
sulla browser/manage_cookies '{"action":"set","assetId":"my-tab","name":"session","value":"abc","domain":".example.com"}'
sulla browser/manage_cookies '{"action":"remove","assetId":"my-tab","url":"https://...","name":"session"}'
```
Actions: `get`, `getAll`, `set`, `remove`.

### `browser/modify_history`
```bash
sulla browser/modify_history '{"action":"add","url":"...","title":"..."}'
sulla browser/modify_history '{"action":"delete","url":"..."}'
sulla browser/modify_history '{"action":"deleteAll"}'
```
Actions: `add`, `delete`, `deleteAll`.

### `browser/search_history`
```bash
sulla browser/search_history '{"query":"github","maxResults":20}'
```
Optional `startTime`/`endTime` (ms epoch) range.

### `browser/agent_storage` — persistent KV store across conversations
```bash
sulla browser/agent_storage '{"action":"set","data":{"task_progress":"step3"}}'
sulla browser/agent_storage '{"action":"get","keys":"task_progress"}'
sulla browser/agent_storage '{"action":"remove","keys":"task_progress"}'
```
Actions: `get`, `set`, `remove`. Survives across conversations — use for task progress, user prefs, cached API responses.

---

## Network & async

### `browser/monitor_network`
```bash
sulla browser/monitor_network '{"action":"capture","durationSeconds":5,"urlFilter":"api.github.com"}'
sulla browser/monitor_network '{"action":"watch_errors","durationSeconds":10}'
```
Returns list of requests with URL, method, status, timing.

### `browser/background_browse` — invisible tab
```bash
sulla browser/background_browse '{"action":"open","url":"https://example.com","waitMs":3000}'
sulla browser/background_browse '{"action":"read","tabId":"...","code":"return document.title"}'
sulla browser/background_browse '{"action":"close","tabId":"..."}'
sulla browser/background_browse '{"action":"list"}'
```
Hidden tab — full JS / cookies / network, but not visible in the UI. For scraping without disrupting what the user sees.

### `browser/schedule_alarm` — in-process timers
```bash
sulla browser/schedule_alarm '{"action":"create","name":"deploy-check","delayInMinutes":5}'
sulla browser/schedule_alarm '{"action":"create","name":"poll","periodInMinutes":10}'
sulla browser/schedule_alarm '{"action":"list"}'
sulla browser/schedule_alarm '{"action":"clear","name":"deploy-check"}'
```
**Alarms do NOT survive app restart.** Use the calendar tool for durable scheduling.

---

## Search across history

### `browser/search_conversations`
```bash
sulla browser/search_conversations '{"action":"search","query":"workflow X","type":"chat"}'
sulla browser/search_conversations '{"action":"recent","limit":10}'
sulla browser/search_conversations '{"action":"get","threadId":"..."}'
```
Searches past chats, browser visits, and workflow executions. Filter `type`: `chat`, `browser`, `workflow`, `graph`.

### `browser/synthesize_tabs` — summarize multiple open tabs
```bash
sulla browser/synthesize_tabs '{"assetIds":["a","b","c"]}'
```
Cross-tab summary.

---

## Common patterns

### Open a page and read it
```bash
sulla browser/tab '{"action":"upsert","url":"https://example.com"}'
# Snapshot is in the response. Done.
```

### Fill a form and submit
```bash
sulla browser/snapshot '{"assetId":"my-tab"}'              # find the field handles
sulla browser/fill '{"assetId":"my-tab","handle":"@field-email","value":"x@y.com"}'
sulla browser/fill '{"assetId":"my-tab","handle":"@field-pw","value":"...","submit":true}'
# submit:true returns the next page's snapshot
```

### Visual click when handles fail
```bash
sulla browser/screenshot '{"assetId":"my-tab","grid":true}'
# Read the screenshot path, find the target visually, note the (x,y)
sulla browser/click_at '{"assetId":"my-tab","x":420,"y":380}'
```

### Wait for content to load
```bash
sulla browser/click '{"assetId":"my-tab","handle":"@btn-load-more"}'
sulla browser/wait '{"assetId":"my-tab","selector":".item-list .item:nth-child(20)","timeout":8000}'
sulla browser/snapshot '{"assetId":"my-tab"}'              # confirm loaded
```

## Limits and gotchas

- **Screenshots are NOT inline base64.** Always returned as `{ path, ... }` — use `Read` on the path for vision.
- **Tab ≠ window.** Tabs live inside Sulla's WebContentsView system, not in a native browser. The user's external Chrome/Safari is invisible to these tools.
- **Trusted events.** All click/type tools use CDP, not synthetic JS events. Auth flows that gate on trust will work.
- **assetId is auto-scoped by thread** — two parallel agents on different threads with the same `assetId` get different tabs.
- **Race condition on first frame after upsert:** if `screenshot` returns empty immediately after `tab` upsert, retry with backoff.

## Reference

- Tool dir: `pkg/rancher-desktop/agent/tools/browser/`
- Manifests: `pkg/rancher-desktop/agent/tools/browser/manifests.ts`
- Tab registry: `pkg/rancher-desktop/main/browserTabs/TabRegistry.ts`
- Guest bridge (page-side runtime): `pkg/rancher-desktop/main/browserTabs/GuestBridge.ts`
- Screenshot store: `~/sulla/artifacts/screenshots/`
