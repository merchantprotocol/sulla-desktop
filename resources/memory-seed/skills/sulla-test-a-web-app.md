---
slug: sulla-test-a-web-app
label: Test a web app through real browser journeys
trigger_when: When someone asks you to test a whole web app, log in to staging, walk through signup, inspect failed requests, or verify a UI visually against user stories.
trigger_actions: [test a web app, test staging, test signup, inspect network failures, visual QA]
trigger_phrases: [test the whole app in the browser, log in to the staging site, walk through signup, check it visually, watch the network, which requests fail, fix what's broken]
scope: [tool-browser, tool-vault, sulla-agents]
---

**When:** Use Sulla's built-in browser for end-to-end browser QA. For a large independent test pass, the `ui-test-manager` agent may coordinate it; give that agent the URL, user stories, allowed test data, and the `ui-test-issues` return contract.

**Do:**
1. Turn requirements into short user journeys with a start state, steps and expected result. Confirm the environment is safe for test data. Never use a real payment, send a real message, or delete real data during a test.
2. Open the exact environment: `sulla browser/tab '{"action":"upsert","url":"https://<staging-host>/"}'`. Save the returned `assetId` and use it in later calls when more than one tab is open.
3. For a saved login, check only metadata with `sulla vault/list '{}'`, then inject it without exposing the password: `sulla vault/autofill '{"origin":"https://<staging-host>","assetId":"<asset-id>"}'`. If credentials are absent or access is not allowed, stop that journey and tell the human what login must be connected.
4. Read the current controls with `sulla browser/snapshot '{"assetId":"<asset-id>","mode":"full"}'`. Use returned handles: `sulla browser/fill '{"handle":"@field-email","value":"<synthetic-email>","assetId":"<asset-id>"}'` and `sulla browser/click '{"handle":"@btn-continue","assetId":"<asset-id>"}'`.
5. After each important transition, take a visual artifact with `sulla browser/screenshot '{"assetId":"<asset-id>","annotate":true}'`. Inspect the returned image path rather than assuming a DOM snapshot proves layout or rendering.
6. Watch the critical journey for failed requests: `sulla browser/monitor_network '{"action":"watch_errors","durationSeconds":20,"urlFilter":"<staging-host>"}'`. Repeat the action during the watch window. Record method, URL path, status and the user-visible effect; do not copy tokens or private response bodies.
7. Test success, validation failure, keyboard use, back/retry, loading, empty and error states that the story requires. Use `sulla browser/press_key '{"key":"Tab","assetId":"<asset-id>"}'` for a basic keyboard pass.
8. Reproduce every issue once from a known start state. Report: title, severity, environment, precondition, numbered steps, expected, actual, network evidence, screenshot path, and whether it reproduces.
9. Fix code through `sulla-ship-a-code-change`, deploy the fix to the same test environment, then rerun the exact failed journey plus a nearby regression journey.
10. Close tabs you opened with `sulla browser/tab '{"action":"remove","assetId":"<asset-id>"}'`. Remove synthetic records only if the test environment has an approved cleanup path; deleting data requires the human's explicit go-ahead.

**Check:** Every requested story has a pass, fail or blocked result; visual claims have screenshots; request failures have network evidence; and fixed issues were retested in the deployed environment.

**Don't:**
- Don't claim you looked at the app from HTML, logs, snapshots or unit tests alone. Use a screenshot for visual claims.
- Don't use coordinates until handles fail; if needed, screenshot first and use `click_at` only on the known asset.
- Don't expose passwords, session cookies, tokens, customer data or private response bodies.
- Don't submit a real order, payment, email, post or destructive action without explicit human approval.
