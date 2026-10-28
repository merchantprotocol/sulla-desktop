---
slug: sulla-show-mockups
label: Create and show branded HTML mockup options
trigger_when: When the human wants several UI directions, hero variations, a brand-matched restyle, or a mockup opened for review before implementation.
trigger_actions: [make mockups, compare design options, create hero variations, match a brand, serve HTML mockups]
trigger_phrases: [show me three mockups, ten hero variations, restyle this to match our brand, open the mockup in my browser, serve these HTML files, pick a design option, build option two, option two, I like this option, build it into the real app, pick a design]
scope: [sulla-agents, tool-browser, tool-docker, sulla-files]
---

**When:** Use this before product UI work. The `mockup-designer` makes self-contained static HTML and does not edit product code. A design pick is a human taste decision.

**Do:**
1. Find the real design inputs: existing token CSS, schema or field definitions, brand assets, current screenshots, target users, and the decision the screen supports. Do not substitute a generic theme when these exist.
2. Confirm the specialist is available: `sulla agents/directory '{"slug":"mockup-designer"}'`. Prepare a dedicated directory under `/mnt/worktrees/_scratch/<job>/mockups/` unless the human asked for a durable design deliverable in Files.
3. Launch it with exact inputs and output paths: `sulla meta/spawn_agent '{"tasks":[{"agentId":"mockup-designer","label":"Design mockup options","visibility":"hidden","prompt":"Create <count> genuinely different self-contained HTML options for <screen>. Read <token-path> and <schema-path>. Match those real tokens and fields. Save to /mnt/worktrees/_scratch/<job>/mockups/option-1.html and the following numbered paths. Return each path and its one-line design rationale.","contract":{"name":"result","description":"HTML paths and design rationales"}}],"parallel":true,"async":true}'`.
4. Review each returned file. Confirm it is self-contained, uses realistic data and actual fields, matches the supplied brand tokens, and differs in layout or interaction rather than color alone. Ten hero options may live on one index page if every option is clearly labeled.
5. Serve the directory from the VM: `sulla docker/run '{"image":"nginx:alpine","name":"sulla-mockup-preview","options":"--detach --publish 8080:80 --volume /mnt/worktrees/_scratch/<job>/mockups:/usr/share/nginx/html:ro"}'`. If that name or port is in use, inspect `sulla docker/ps '{"all":true}'` and choose another explicit name or port.
6. Open the preview in Sulla's browser: `sulla browser/tab '{"action":"upsert","url":"http://127.0.0.1:8080/option-1.html","title":"Mockup review"}'`. If the browser cannot reach VM loopback, use the reachable VM address reported by the environment; verify the page before sharing it.
7. Ask for the taste decision once with `ask_user_question`, listing the options and recommending one with a short reason. Record the selected option, its exact file, and requested changes. Do not infer a pick from silence.
8. Only after the pick, brief the coding owner to implement the selected file in the real app. Link `sulla-spawn-and-manage-agents`; include product repo, real component paths, selected mockup, constraints, and acceptance checks. The designer itself never wires product code.
9. When review is over, stop the preview: `sulla docker/stop '{"container":"sulla-mockup-preview"}'`. Removing the container or deleting mockup files waits for the human's explicit go-ahead; otherwise leave them clearly identified for later cleanup.

**Check:** Every option opens; brand tokens and schema match the real inputs; options are meaningfully different; the human's explicit pick is recorded before implementation.

**Cleanup:** Close or reuse the preview tab, stop the named container, and disclose any retained container or scratch directory. Do not delete retained files without the human's tap.

**Don't:**
- Don't let the mockup agent edit product source or open a PR.
- Don't call a color swap a new design direction.
- Don't build an unselected option into the app.
- Don't expose a preview beyond the local machine unless the human asked and access is protected.
