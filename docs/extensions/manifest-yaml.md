# manifest.yaml Reference

The `manifest.yaml` file defines how your extension appears in the Sulla Desktop marketplace catalog. It contains the metadata, description, labels, and branding that users see when browsing extensions.

## Full Schema

```yaml
- slug: docker.io/your-org/your-extension
  version: 1.0.0
  containerd_compatible: true
  labels:
    com.docker.desktop.extension.api.version: 0.0.1
    com.docker.extension.icon: https://example.com/icon.svg
    com.docker.extension.additional-urls: ""
    com.docker.extension.categories: productivity,utility-tools
    com.docker.extension.changelog: >
      <h3>Recent Updates</h3>
      <h4>1.0.0</h4>
      <ul><li>Initial release</li></ul>
    com.docker.extension.detailed-description: >
      Full HTML description of your extension.
      <br><br>
      <strong>Features:</strong>
      <ul>
        <li>Feature 1</li>
        <li>Feature 2</li>
      </ul>
    com.docker.extension.publisher-url: https://github.com/your-org/your-extension
    com.docker.extension.screenshots: ""
    org.opencontainers.image.authors: Your Name
    org.opencontainers.image.created: 2026-01-01T00:00:00Z
    org.opencontainers.image.description: Short one-line description
    org.opencontainers.image.licenses: MIT
    org.opencontainers.image.source: https://github.com/your-org/your-extension
    org.opencontainers.image.title: My Extension by Your Org
    org.opencontainers.image.url: https://hub.docker.com/r/your-org/your-extension
    org.opencontainers.image.vendor: Your Org
    org.opencontainers.image.version: 1.0.0
  title: My Extension by Your Org
  logo: https://example.com/logo.png
  publisher: Your Org
  short_description: One-line summary shown in the catalog card
  installable: https://raw.githubusercontent.com/merchantprotocol/sulla-recipes/refs/heads/main/recipes/your-extension/installation.yaml
```

## Field Reference

### Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slug` | string | Yes | Unique identifier in Docker Hub format: `docker.io/<org>/<name>`. This is the extension ID used throughout the system. |
| `version` | string | Yes | Current version. Must match your `installation.yaml` version. |
| `containerd_compatible` | boolean | Yes | Set to `true`. Required for compatibility. |
| `title` | string | Yes | Full display title (e.g. "Stirling-PDF by Sulla Labs"). |
| `logo` | string | Yes | URL to your extension's logo/icon. Shown in the catalog cards. |
| `publisher` | string | Yes | Your organization or author name. |
| `short_description` | string | Yes | One-line description shown on the catalog card. Keep it under 120 characters. |
| `installable` | string | Yes | Raw GitHub URL to your `installation.yaml`. This is what makes it a recipe-based extension. |
| `labels` | object | Yes | Metadata labels (see below). |

### The `installable` Field

This is the critical field that tells Sulla Desktop your extension is recipe-based (not a legacy Docker image extension). It must be the raw GitHub URL to your `installation.yaml`:

```yaml
installable: https://raw.githubusercontent.com/merchantprotocol/sulla-recipes/refs/heads/main/recipes/your-extension/installation.yaml
```

Without this field, Sulla will try to install your extension as a legacy Docker image — which is not what you want.

### Labels

Labels follow the OCI (Open Container Initiative) and Docker Desktop Extension conventions. They provide metadata for the catalog UI.

#### Required Labels

| Label | Description |
|-------|-------------|
| `com.docker.desktop.extension.api.version` | Always `0.0.1`. |
| `com.docker.extension.icon` | URL to your extension icon. |
| `com.docker.extension.categories` | Comma-separated categories (e.g. `productivity,documents,utilities`). |
| `com.docker.extension.detailed-description` | Full HTML description. Supports basic HTML tags. |
| `org.opencontainers.image.title` | Display title for the extension. |
| `org.opencontainers.image.description` | Short plain-text description. |
| `org.opencontainers.image.vendor` | Your organization name. |
| `org.opencontainers.image.version` | Must match the top-level `version`. |
| `org.opencontainers.image.authors` | Author name(s). |

#### Optional Labels

| Label | Description |
|-------|-------------|
| `com.docker.extension.additional-urls` | Additional URLs (legacy format, prefer `extraUrls` in `installation.yaml`). |
| `com.docker.extension.changelog` | HTML changelog for the extension. |
| `com.docker.extension.publisher-url` | URL to your project or organization page. |
| `com.docker.extension.screenshots` | Comma-separated screenshot URLs (not yet implemented in UI). |
| `org.opencontainers.image.created` | ISO 8601 creation timestamp. |
| `org.opencontainers.image.licenses` | SPDX license identifier (e.g. `MIT`, `Apache-2.0`). |
| `org.opencontainers.image.source` | URL to your source repository. |
| `org.opencontainers.image.url` | URL to your Docker Hub page or homepage. |

### Categories

Use one or more of these standard categories (comma-separated in the label):

| Category | Use For |
|----------|---------|
| `productivity` | Office tools, PDF editors, note-taking |
| `email` | Mail servers, webmail clients |
| `media` | Media servers, streaming, photo management |
| `communication` | Chat, VoIP, video conferencing |
| `business` | CRM, accounting, ERP |
| `development` | Dev tools, CI/CD, code editors |
| `security` | VPN, firewalls, password managers |
| `utility-tools` | System utilities, monitoring, backups |
| `documents` | Document management, wikis |
| `server` | Server infrastructure, DNS, web servers |

### Writing the Detailed Description

The `com.docker.extension.detailed-description` label supports basic HTML and is displayed on the extension detail page. Best practices:

- Start with a strong one-liner about what your extension does
- Use `<strong>` for emphasis, `<ul>/<li>` for feature lists
- Include a **Features** section
- Include a **Requirements** section with minimum specs
- Keep it scannable — users won't read walls of text

```yaml
com.docker.extension.detailed-description: >
  <strong>My Extension</strong> does X, Y, and Z locally on your machine.
  <br><br>
  <strong>Features:</strong>
  <ul>
    <li>Feature one</li>
    <li>Feature two</li>
    <li>Feature three</li>
  </ul>
  <br>
  <strong>Requirements:</strong>
  <ul>
    <li>Sulla Desktop v1.0.0+</li>
    <li>1GB+ RAM</li>
  </ul>
```

## Relationship to index.yaml

Your `manifest.yaml` entry must also be added to the root `index.yaml` file in the sulla-recipes repository. The `index.yaml` is the master catalog that Sulla Desktop fetches to populate the marketplace.

The format is identical — your `manifest.yaml` entry is simply copied into the `plugins` array in `index.yaml`. See [Submitting Your Extension](./submitting.md) for details.
