---
slug: sulla-build-a-recipe
label: Build and test a Sulla Docker recipe
trigger_when: When a plugin needs a long-running local service, Docker Compose stack, web UI, ports, volumes, health checks, or extension lifecycle controls.
trigger_actions: [build recipe, package compose service, install recipe, test extension service]
trigger_phrases: [Docker recipe, compose extension, container plugin, local service add-on, installation.yaml]
scope: [sulla-plugins, sulla-extensions]
---

**Do:**
1. Copy `examples/extensions/hello-recipe` or scaffold: `sulla marketplace/scaffold '{"kind":"recipe","slug":"my-service","name":"My service","description":"Runs a local service"}'`.
2. Keep `manifest.yaml`, `installation.yaml`, `docker-compose.yml`, and an icon together. Use fixed image versions, a unique documented host port, a restart policy, and `{{path.data}}` or a named volume for persistent state.
3. Use this complete minimum:

```yaml
# installation.yaml
slug: my-service
name: My service
description: Runs a small local web service.
version: "1.0.0"
publisher: Example publisher
categories: [development]
icon: icon.png
compose: {composeFile: docker-compose.yml}
setup: []
commands:
  start: docker compose -f ${COMPOSE_FILE} up -d
  stop: docker compose -f ${COMPOSE_FILE} down
  restart: docker compose -f ${COMPOSE_FILE} restart
  status: docker compose -f ${COMPOSE_FILE} ps
  logs: docker compose -f ${COMPOSE_FILE} logs --tail=100
extraUrls:
  - {label: Dashboard, url: "http://localhost:30300"}
```

```yaml
# docker-compose.yml
services:
  my-service:
    image: example/my-service:1.0.0
    ports: ["30300:8080"]
    volumes: ["{{path.data}}:/data"]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

4. In commands, `${APP_DIR}` and `${COMPOSE_FILE}` are shell substitutions. In Compose and `env`, `{{name}}` resolves settings, `{{INTEGRATION.PROPERTY}}` resolves configured integration values, and `{{path.data}}` is persistent recipe data. Do not mix the syntaxes or put credentials in committed files.
5. Declare setup steps as `{command, cwd?, optional?}`. Set `optional: false` for required setup; the default is optional. Never hide a required interactive step behind an optional failure.
6. Validate: `sulla marketplace/validate '{"kind":"recipe","slug":"my-service"}'`. Review rendered Compose, port collisions, volume ownership, health behavior, update behavior, and every URL.
7. Publish the reviewed Files drafts through `files/request_publish` and wait for Decide approval. For a catalog recipe, install the exact `slug:version`: `sulla extensions/install_extension '{"id":"docker.io/<publisher>/my-service:1.0.0"}'`; installation starts it automatically.
8. Verify: `sulla extensions/get_extension_status '{"id":"docker.io/<publisher>/my-service"}'`, then `sulla extensions/list_installed_extensions '{}'`. Open every `extraUrls` entry and make one harmless request. Check service health, persistence after restart, recent logs, and failure behavior.
9. Before stopping, check impact. Stop only after the required explicit decision, then call `sulla extensions/stop_extension '{"id":"docker.io/<publisher>/my-service","confirm":true}'`; restart with `sulla extensions/start_extension '{"id":"docker.io/<publisher>/my-service"}'`.
10. Uninstall only after the human's tap because it deletes installed state. Default to preserving data: `sulla extensions/uninstall_extension '{"id":"docker.io/<publisher>/my-service","deleteData":false}'`. Never set `deleteData:true` without separate explicit approval.
11. Prepare marketplace submission and use the approval step in `sulla-build-a-plugin`. The older public recipe catalog also requires matching `manifest.yaml`/index metadata and a reviewed upstream PR; do not submit either route without approval.

**Check:** Status is running, the health check is healthy, declared URLs work, restart preserves data, stop/start works, and uninstall preservation is understood.

**Don't:** use `latest`, expose undocumented ports, bind secrets into source, rely only on `docker compose ps`, or destroy persistent data as part of a routine test.
