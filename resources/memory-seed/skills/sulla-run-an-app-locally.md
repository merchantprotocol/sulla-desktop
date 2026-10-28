---
slug: sulla-run-an-app-locally
label: Build, start and restore a local app stack
trigger_when: When someone asks you to build and run an app in Docker, bring a local development stack back up, load safe test data, inspect startup errors, or serve local HTML.
trigger_actions: [run an app locally, start a dev stack, seed test data, serve HTML, inspect container logs]
trigger_phrases: [bring the local dev stack back up, test data, build and run this app in a container, serve these HTML files, app will not start, container keeps stopping]
scope: [tool-docker, tool-browser]
---

**When:** Use this for a local container or development stack. Read the repository's Dockerfile, compose file, README and sample environment file before choosing commands.

**Do:**
1. Inspect the current state first: `sulla docker/ps '{"all":true}'` and `sulla docker/images '{"all":true}'`. Reuse the project's documented containers and volumes; do not invent a parallel stack when one exists.
2. Validate required non-secret configuration from the repository docs. Keep secrets in the vault or the project's existing ignored environment file; never pass a secret in a command that will be logged.
3. Build when source or the image is missing: `sulla docker/build '{"path":"/mnt/worktrees/<repo>-<branch>","tag":"<app>:dev","options":"--file Dockerfile"}'`. Read the first actionable build error and fix it through `sulla-ship-a-code-change` rather than repeatedly rebuilding unchanged input.
4. Start one documented service with explicit ports and a stable name: `sulla docker/run '{"image":"<app>:dev","name":"<app>-dev","options":"--detach --publish 127.0.0.1:<host-port>:<container-port>"}'`. Use documented volume and network flags only.
5. Check startup: `sulla docker/ps '{"all":true}'` and `sulla docker/logs '{"container":"<app>-dev","tail":120}'`. If it exited, diagnose the first root error, not later cascade errors.
6. Run the repository's idempotent test-data command inside the named container: `sulla docker/exec '{"container":"<app>-dev","command":"<documented-seed-command>"}'`. Use synthetic fixtures only; never copy production data into a local stack.
7. Open the app at the VM-reachable URL: `sulla browser/tab '{"action":"upsert","url":"http://127.0.0.1:<host-port>/"}'`. Check a screenshot and one health or critical path. If the browser cannot reach loopback, inspect the container's published address and use the documented VM gateway rather than changing firewall rules blindly.
8. Stop the exact container when the session ends: `sulla docker/stop '{"container":"<app>-dev"}'`. Removing the container, image, volume or seeded records deletes data and waits for explicit human approval; prepare the exact names and ask once with `ask_user_question`.

**Check:** The named container remains running, logs show the expected ready signal, the health URL succeeds, the app renders in the browser, and test data is visibly present without production data.

**Don't:**
- Don't use an unpinned public image, expose a development service on every interface, or print environment values.
- Don't run a seed command twice unless it is documented as idempotent.
- Don't remove containers, images or volumes as routine cleanup. Stop is reversible; removal waits for approval.
