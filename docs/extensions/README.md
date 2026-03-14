# Building Extensions for Sulla Desktop

Extensions are self-contained applications that run as Docker containers inside Sulla Desktop. You provide a **Docker Compose recipe** and an **installation manifest** — Sulla handles the rest.

## How It Works

```
┌──────────────────────────────────────────────────────┐
│  Sulla Desktop                                        │
│                                                       │
│  ┌─────────────┐   ┌─────────────────────────────┐   │
│  │  Extension   │   │  Your Docker Containers      │   │
│  │  Manager     │──▶│  (from your docker-compose)  │   │
│  └──────┬──────┘   └─────────────────────────────┘   │
│         │                                             │
│         ▼                                             │
│  ┌──────────────┐                                     │
│  │ installation │  ← Your recipe tells Sulla what     │
│  │ .yaml        │    to run and how to manage it      │
│  └──────────────┘                                     │
└──────────────────────────────────────────────────────┘
```

Your extension is **just a Docker Compose stack**. Sulla Desktop:

1. Downloads your recipe files from the [sulla-recipes](https://github.com/sulla-ai/sulla-recipes) repository
2. Runs any setup commands you define (e.g. `git clone`, config generation)
3. Starts your containers with `docker compose up -d`
4. Registers your URLs in the app UI and system tray
5. Manages the lifecycle (start, stop, restart, update, uninstall)

## Repository Structure

All extensions live in the [`sulla-ai/sulla-recipes`](https://github.com/sulla-ai/sulla-recipes) repository:

```
sulla-recipes/
├── index.yaml                  # Master catalog (all extensions listed here)
└── recipes/
    ├── stirling-pdf/
    │   ├── installation.yaml   # How Sulla installs & runs your extension
    │   ├── manifest.yaml       # Catalog metadata (labels, description, etc.)
    │   ├── docker-compose.yml  # Your Docker Compose recipe
    │   └── stirling.svg        # Your extension icon
    ├── mailcow/
    │   ├── installation.yaml
    │   ├── manifest.yaml
    │   └── cow_mailcow.svg
    └── your-extension/
        ├── installation.yaml
        ├── manifest.yaml
        ├── docker-compose.yml
        └── icon.png
```

## Key Files

| File | Purpose | Required |
|------|---------|----------|
| [`installation.yaml`](./installation-yaml.md) | Tells Sulla how to install, start, stop, and manage your extension | Yes |
| [`manifest.yaml`](./manifest-yaml.md) | Catalog metadata — title, description, icon, categories | Yes |
| `docker-compose.yml` | Your Docker Compose stack | Yes (unless using git clone) |
| Icon file (`.png`, `.svg`) | Extension icon for the UI and catalog | Recommended |

## Architecture Principles

### Your extension is a Docker container

That's it. Write a `docker-compose.yml` that defines your services, volumes, ports, and environment variables. Sulla pulls and runs it exactly as you define.

### Shared infrastructure

Sulla Desktop may already be running common infrastructure containers (MySQL, Redis, Nginx, etc.). Your `docker-compose.yml` can connect to these shared resources by referencing their Docker networks. This avoids duplicating databases and services that the user already has running.

For example, if Sulla already runs a MariaDB instance, your extension can use it instead of spinning up its own:

```yaml
services:
  my-app:
    image: my-app:latest
    environment:
      - DB_HOST=sulla-mariadb
      - DB_PORT=3306
    networks:
      - sulla-shared

networks:
  sulla-shared:
    external: true
```

### Variable substitution powers your config

Sulla Desktop resolves `{{variables}}` in your `docker-compose.yml` and `env` field at install time, and refreshes the `.env` file on every start. This means your recipe can reference user-specific settings, integration credentials, and local filesystem paths — all without the user editing config files.

Three namespaces are available:

| Syntax | Source | Example |
|--------|--------|---------|
| `{{propertyName}}` | Sulla Settings | `{{sullaEmail}}` → `user@example.com` |
| `{{INTEGRATION.PROP}}` | Integration Service | `{{SLACK.BOT_KEY}}` → `xoxb-...` |
| `{{path.name}}` | Built-in user paths | `{{path.movies}}` → `/Users/me/Movies` |

Values can be piped through **modifiers** for safe embedding:

| Modifier | Effect | Use case |
|----------|--------|----------|
| `urlencode` | Percent-encode | Passwords in connection strings |
| `base64` | Base64-encode | Secrets in config files |
| `quote` | Shell single-quote | Paths with spaces in shell commands |
| `json` | JSON-stringify | Values in JSON config |

```yaml
# docker-compose.yml
environment:
  ADMIN_EMAIL: "{{sullaEmail}}"
  PG_URL: "postgres://app:{{sullaServicePassword|urlencode}}@db:5432/myapp"
volumes:
  - {{path.movies}}:/data/movies
  - {{path.music}}:/data/music
```

See the full [Variable Reference](./installation-yaml.md#variable-reference) for all available variables.

### Environment variables

Define expected environment variables in the `env` section of `installation.yaml`. Sulla writes them as a `.env` file in the extension directory — Docker Compose reads it automatically. The `.env` is refreshed on every start, so setting changes take effect on restart.

```yaml
env:
  DOMAIN: "localhost"
  DB_HOST: "sulla-mariadb"
  ADMIN_EMAIL: "{{sullaEmail}}"
  ENABLE_SSL: "false"
```

### Commands are just shell commands

Sulla doesn't interpret your commands — it just runs them. The `setup` section and `commands` section are both plain shell commands executed via `/bin/sh -c`. You have full control.

Two variables are substituted before execution:

| Variable | Resolves To |
|----------|-------------|
| `${APP_DIR}` | The extension's local directory (e.g. `~/Library/Application Support/sulla-desktop/extensions/stirling-pdf/`) |
| `${COMPOSE_FILE}` | Full path to your compose file (e.g. `${APP_DIR}/docker-compose.yml`) |

> **Note:** `${VAR}` syntax is for shell command substitution in `setup` and `commands`. `{{var}}` syntax is for docker-compose files and `env` values.

## Quick Start

The fastest way to build an extension:

1. **Create your recipe folder** in `recipes/your-extension/`
2. **Write a `docker-compose.yml`** that runs your app
3. **Write an `installation.yaml`** that tells Sulla how to manage it
4. **Write a `manifest.yaml`** with your catalog metadata
5. **Add an icon** (PNG recommended for tray compatibility)
6. **Add your entry to `index.yaml`** in the repo root
7. **Submit a pull request** to [sulla-recipes](https://github.com/sulla-ai/sulla-recipes)

See [Submitting Your Extension](./submitting.md) for the full walkthrough.

## Documentation

- **[installation.yaml Reference](./installation-yaml.md)** — Every field explained
- **[Variable Reference](./installation-yaml.md#variable-reference)** — Settings, integrations, paths, and modifiers
- **[Variables Copy-Paste](./variables.md)** — All variables in one place, ready to copy
- **[manifest.yaml Reference](./manifest-yaml.md)** — Catalog listing format
- **[Submitting Your Extension](./submitting.md)** — Step-by-step PR guide
- **[Examples](./examples.md)** — Real-world examples with annotations
