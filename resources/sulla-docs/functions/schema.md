# Sulla Functions — function.yaml Schema

## Complete Schema

```yaml
apiVersion: sulla/v1           # Required. Always this value.
kind: Function                 # Required. Always this value.

id: function-my-slug           # Required. Pattern: function-[a-z0-9-]+
name: My Function              # Required. Display name.
description: |                 # Required. What it does.
  Multi-line description.

schemaversion: 1               # Required. Always 1.
slug: my-slug                  # Must match directory name and id suffix.
tags: [example, python]        # Optional.
enabled: true                  # Optional. Default true.
author: sulla@example.com      # Optional.
createdAt: "2026-04-23T00:00:00.000Z"
updatedAt: "2026-04-23T00:00:00.000Z"

spec:
  runtime: python              # Required. python | node | shell | agent
  entrypoint: main.py::handler # Required. <file>::<function> for python/node, <file> for shell
  compatibility: "python>=3.10" # Optional. e.g., node>=20, bash>=5

  inputs:                      # Optional. Declared input parameters.
    param_name:
      type: string             # string|number|integer|boolean|object|array|null
      description: "What this param does"
      default: "default_value" # Optional default
      required: false          # Optional. Default false.
      enum: [a, b, c]          # Optional. Restrict to these values.
      minimum: 0               # Optional. For numbers.
      maximum: 100             # Optional. For numbers.

  outputs:                     # Optional. Declared return values.
    output_name:
      type: string
      description: "What this output contains"

  integrations:                # Optional. External service dependencies.
    - slug: slack
      env:
        SLACK_TOKEN: bot_token  # Maps env var → vault property name

  permissions:                 # Optional. Access control.
    network: []                # Empty = no network. List hostnames to allow.
    filesystem:                # Optional file system access.
      - path: /data
        mode: read             # read | write
    env: []                    # Env vars to expose (beyond integration vars).

  timeout: 60s                 # Optional. Duration: Xs|Xm|Xh. Default 60s.
```

---

## ID & Slug Rules

- `id` must be `function-` + slug: e.g., `function-social-cache-read`
- `slug` must match the directory name: `~/sulla/functions/<slug>/`
- Pattern: lowercase letters, numbers, hyphens. No spaces.

---

## Input/Output Types

| type | Description | Extra fields |
|------|-------------|-------------|
| `string` | Text value | `enum`, `pattern`, `format` |
| `number` | Float or int | `minimum`, `maximum` |
| `integer` | Integer only | `minimum`, `maximum` |
| `boolean` | true/false | — |
| `object` | JSON object | `properties` (nested schema) |
| `array` | JSON array | `items` (schema for each element) |
| `null` | Null value | — |

Types can be arrays for multi-type: `type: [string, "null"]`

---

## Permissions Examples

```yaml
# No network, no special filesystem
permissions:
  network: []
  env: []

# External API access
permissions:
  network:
    - api.slack.com
    - hooks.slack.com
  env: []

# File write access
permissions:
  network: []
  filesystem:
    - path: /home/user/sulla/content
      mode: write
  env: []
```

---

## Integrations Example

```yaml
spec:
  integrations:
    - slug: slack
      env:
        SLACK_TOKEN: bot_token          # $SLACK_TOKEN in runtime = vault slot "bot_token"
        SLACK_SIGNING_SECRET: signing_secret
  permissions:
    network:
      - slack.com
```

When the function runs, `os.environ["SLACK_TOKEN"]` is populated from the vault automatically.
