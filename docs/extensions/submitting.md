# Submitting Your Extension

All Sulla Desktop extensions are published through the [`merchantprotocol/sulla-recipes`](https://github.com/merchantprotocol/sulla-recipes) repository. To get your extension listed in the marketplace, you submit a pull request with your recipe files.

## Prerequisites

- A working Docker Compose stack for your application
- A GitHub account
- Basic familiarity with Git and pull requests

## Step-by-Step Guide

### 1. Fork and Clone the Repository

```bash
# Fork the repo on GitHub first, then:
git clone https://github.com/YOUR-USERNAME/sulla-recipes.git
cd sulla-recipes
git checkout -b add-my-extension
```

### 2. Create Your Recipe Folder

Create a new directory under `recipes/` named after your extension (lowercase, hyphens):

```bash
mkdir -p recipes/my-extension
```

### 3. Add Your Docker Compose File

Create `recipes/my-extension/docker-compose.yml`:

```yaml
version: "3.8"

services:
  my-app:
    image: your-org/your-app:latest
    container_name: my-extension
    ports:
      - "30300:8080"
    volumes:
      - app-data:/data
    environment:
      - APP_ENV=production
    restart: unless-stopped

volumes:
  app-data:
```

**Port guidelines:**
- Use ports in the `30000-31000` range to avoid conflicts with common services
- Map your internal port to a unique external port
- Document your port in `installation.yaml` via `defaultPort`

### 4. Create Your installation.yaml

Create `recipes/my-extension/installation.yaml`:

```yaml
id: my-extension
name: My Extension
description: What your extension does in one line
icon: icon.png
version: "1.0.0"
category: productivity

compose:
  composeFile: "docker-compose.yml"

setup: []

commands:
  start:   "docker compose -f ${COMPOSE_FILE} up -d"
  stop:    "docker compose -f ${COMPOSE_FILE} down"
  restart: "docker compose -f ${COMPOSE_FILE} restart"
  status:  "docker compose -f ${COMPOSE_FILE} ps"
  update:  "docker compose -f ${COMPOSE_FILE} pull && docker compose -f ${COMPOSE_FILE} up -d"
  logs:    "docker compose -f ${COMPOSE_FILE} logs --tail=100"

extraUrls:
  - label: "Open My Extension"
    url: "http://localhost:30300"

env:
  APP_ENV: "production"
```

See [installation.yaml Reference](./installation-yaml.md) for all available fields.

### 5. Create Your manifest.yaml

Create `recipes/my-extension/manifest.yaml`:

```yaml
- slug: docker.io/your-org/my-extension
  version: 1.0.0
  containerd_compatible: true
  labels:
    com.docker.desktop.extension.api.version: 0.0.1
    com.docker.extension.icon: https://raw.githubusercontent.com/merchantprotocol/sulla-recipes/main/recipes/my-extension/icon.png
    com.docker.extension.additional-urls: ""
    com.docker.extension.categories: productivity,utility-tools
    com.docker.extension.changelog: >
      <h3>1.0.0</h3><ul><li>Initial release</li></ul>
    com.docker.extension.detailed-description: >
      <strong>My Extension</strong> does amazing things locally on your machine.
      <br><br>
      <strong>Features:</strong>
      <ul>
        <li>Feature one</li>
        <li>Feature two</li>
      </ul>
      <br>
      <strong>Requirements:</strong>
      <ul>
        <li>Sulla Desktop v1.0.0+</li>
        <li>1GB+ RAM</li>
      </ul>
    com.docker.extension.publisher-url: https://github.com/your-org/my-extension
    com.docker.extension.screenshots: ""
    org.opencontainers.image.authors: Your Name
    org.opencontainers.image.created: 2026-01-01T00:00:00Z
    org.opencontainers.image.description: Short one-line description of my extension
    org.opencontainers.image.licenses: MIT
    org.opencontainers.image.source: https://github.com/your-org/my-extension
    org.opencontainers.image.title: My Extension by Your Org
    org.opencontainers.image.url: ""
    org.opencontainers.image.vendor: Your Org
    org.opencontainers.image.version: 1.0.0
  title: My Extension by Your Org
  logo: https://raw.githubusercontent.com/merchantprotocol/sulla-recipes/main/recipes/my-extension/icon.png
  publisher: Your Org
  short_description: Short one-line description of my extension
  installable: https://raw.githubusercontent.com/merchantprotocol/sulla-recipes/refs/heads/main/recipes/my-extension/installation.yaml
```

See [manifest.yaml Reference](./manifest-yaml.md) for all available fields.

### 6. Add Your Icon

Add an icon file to your recipe folder. Supported formats:

| Format | Recommended | Notes |
|--------|-------------|-------|
| PNG | **Yes** | Best compatibility. Works in system tray, UI, and catalog. |
| SVG | OK for catalog | System tray on macOS/Windows does not support SVG. PNG fallback recommended. |

Place it as `recipes/my-extension/icon.png` (or `.svg`).

### 7. Add Your Entry to index.yaml

Open the root `index.yaml` file and add your manifest entry to the `plugins` array. Copy the contents of your `manifest.yaml` and paste it at the end of the `plugins` list:

```yaml
# index.yaml
version: "1"
generated_at: ""
plugins:
  # ... existing entries ...

  - slug: docker.io/your-org/my-extension
    version: 1.0.0
    # ... rest of your manifest entry ...
    installable: https://raw.githubusercontent.com/merchantprotocol/sulla-recipes/refs/heads/main/recipes/my-extension/installation.yaml
```

The `installable` field is what makes your extension recipe-based. **Do not omit it.**

### 8. Test Locally

Before submitting, verify your recipe works:

```bash
# Test your docker-compose works standalone
cd recipes/my-extension
docker compose up -d
docker compose ps
docker compose down

# Verify your YAML is valid
python3 -c "import yaml; yaml.safe_load(open('installation.yaml'))"
python3 -c "import yaml; yaml.safe_load(open('manifest.yaml'))"
```

### 9. Commit and Push

```bash
git add recipes/my-extension/
git add index.yaml
git commit -m "Add my-extension recipe"
git push origin add-my-extension
```

### 10. Submit a Pull Request

Go to [https://github.com/merchantprotocol/sulla-recipes/pulls](https://github.com/merchantprotocol/sulla-recipes/pulls) and create a new pull request from your branch.

**Your PR should include:**

- [ ] `recipes/my-extension/installation.yaml`
- [ ] `recipes/my-extension/manifest.yaml`
- [ ] `recipes/my-extension/docker-compose.yml`
- [ ] `recipes/my-extension/icon.png` (or `.svg`)
- [ ] Updated `index.yaml` with your entry added

**In the PR description, include:**

- What your extension does
- Which ports it uses
- Any shared infrastructure it depends on (MySQL, Redis, etc.)
- Whether it requires any special setup (DNS, domain, etc.)
- How you tested it

## PR Review Checklist

The Sulla team will review your PR against these criteria:

| Check | What We Look For |
|-------|-----------------|
| **Unique ID** | `id` in `installation.yaml` is unique and matches folder name |
| **Unique ports** | No port conflicts with existing extensions |
| **Working compose** | `docker compose up -d` succeeds |
| **Commands work** | start/stop/restart/status all function |
| **Icon present** | PNG or SVG icon included and properly referenced |
| **Clean recipe** | No unnecessary files, secrets, or credentials |
| **extraUrls valid** | All URLs resolve to the correct service |
| **Description quality** | Clear, honest description without marketing fluff |

## Updating Your Extension

To publish a new version:

1. Update `version` in both `installation.yaml` and `manifest.yaml`
2. Update the `version` and any changed fields in your `index.yaml` entry
3. Update the changelog in the `com.docker.extension.changelog` label
4. Submit a PR with the changes

## Removing Your Extension

To remove your extension from the marketplace, submit a PR that:

1. Removes your folder from `recipes/`
2. Removes your entry from `index.yaml`

Existing installations will continue to work but won't receive updates.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Missing `installable` field in manifest/index | Sulla treats it as a legacy Docker image extension and install fails |
| Version mismatch between files | Keep `version` identical in `installation.yaml`, `manifest.yaml`, and `index.yaml` |
| Hardcoded paths in commands | Use `${APP_DIR}` and `${COMPOSE_FILE}` variables |
| Using host ports below 30000 | Use the 30000-31000 range to avoid conflicts |
| SVG icon only | Add a PNG version — system tray doesn't support SVG |
| Committing secrets or `.env` files | Use the `env` section in `installation.yaml` for defaults instead |
