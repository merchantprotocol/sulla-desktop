---
slug: sulla-tool-extensions
label: Use the Sulla Extensions tools
trigger_when: When you need to use Sulla Extensions operations.
trigger_actions: [extensions, extensions tools]
trigger_phrases: [extensions, extensions]
scope: [tool-extensions]
---

**When:** When you need to use Sulla Extensions operations.

**Do:**
1. Use the exact command and parameters listed below.
2. Read returned state before making a follow-up change.
3. Keep destructive actions behind their required confirmation fields.

**Tools:**

# extensions tools

Tools for browsing the extension marketplace catalog, listing installed extensions, installing new extensions, and uninstalling extensions. Extensions are Docker Compose stacks managed by Sulla Desktop.

## get_extension_status

Check whether an extension is running, stopped, or not installed. Use before start/stop to avoid surprises.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |

**Example**

```bash
sulla extensions/get_extension_status '{"id":"<id>"}'
```

## install_extension

Install an extension from the marketplace. Provide the extension ID in slug:version format (e.g. "docker.io/merchantprotocol/stirling-pdf:2026.02").

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |

**Example**

```bash
sulla extensions/install_extension '{"id":"<id>"}'
```

## list_extension_catalog

List all available extensions from the Sulla marketplace catalog. Optionally filter by category or search query.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `category` | string | Optional |
| `query` | string | Optional |

**Example**

```bash
sulla extensions/list_extension_catalog '{}'
```

## list_installed_extensions

List all currently installed extensions with their versions, URLs, and upgrade status.

**Parameters**

None.

**Example**

```bash
sulla extensions/list_installed_extensions '{}'
```

## start_extension

Start a previously-installed extension (recipe). The container stack comes back up; web UIs and integrations become reachable again.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |

**Example**

```bash
sulla extensions/start_extension '{"id":"<id>"}'
```

## stop_extension

Stop a running extension (recipe). Container stack goes down — web UI and integrations stop responding.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |
| `confirm` | boolean | Required |

**Example**

```bash
sulla extensions/stop_extension '{"id":"<id>","confirm":"<confirm>"}'
```

## uninstall_extension

Uninstall an installed extension. By default preserves the data/ directory so user data survives reinstall.

**Parameters**

| Name | Type | Requirement |
| --- | --- | --- |
| `id` | string | Required |
| `deleteData` | boolean | Optional |

**Example**

```bash
sulla extensions/uninstall_extension '{"id":"<id>"}'
```


**Don't:**
- Don't invent tool names or parameters; check `sulla meta/browse_tools` when the catalog and source differ.
- Don't expose secrets, tokens, or private data in output.
