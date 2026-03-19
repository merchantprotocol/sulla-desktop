# Integrations API

## Overview

Sulla exposes integration API endpoints over HTTP, allowing models to programmatically call third-party APIs (YouTube, GitHub, Slack, Postmark, etc.) and MCP (Model Context Protocol) servers with full credential management. The model writes Python scripts (via the `exec` tool) to make HTTP requests against these endpoints and process the results itself.

There are two types of integrations:
- **YAML-configured REST integrations** — Static endpoint definitions in `~/sulla/integrations/{slug}/` (140+ services)
- **MCP server integrations** — Dynamic tool discovery from connected MCP servers (see [MCP Integration](./mcp.md))

Both types are exposed through the same unified HTTP API. The `discover-and-call-integrations` skill teaches agents the complete workflow.

These endpoints run on the same Express server as the OpenAI-compatible API (port 3000).

## Access

**Local Access (from host):** `http://localhost:3000`

**Container Access (from Docker/Kubernetes pods):** `http://host.docker.internal:3000`

## Endpoints

### GET /v1/integrations

Lists all available integrations and their endpoints, including parameter schemas. This includes both YAML-configured REST integrations and dynamically discovered MCP server tools.

**Response Format:**
```json
{
  "success": true,
  "integrations": [
    {
      "slug": "youtube",
      "name": "youtube-data-v3",
      "endpoints": [
        {
          "name": "search",
          "method": "GET",
          "path": "/youtube/v3/search",
          "description": "Search for YouTube videos, channels, and playlists",
          "auth": "required",
          "queryParams": [
            {
              "name": "q",
              "type": "string",
              "required": true,
              "description": "Search query"
            },
            {
              "name": "maxResults",
              "type": "integer",
              "required": false,
              "default": 5,
              "description": "Maximum number of results",
              "min": 1,
              "max": 50
            }
          ],
          "pathParams": []
        }
      ]
    }
  ]
}
```

**Example:**
```bash
curl http://localhost:3000/v1/integrations
```

### POST /v1/integrations/:accountId/:slug/:endpoint/call

Execute an API call against a YAML-configured integration endpoint using specific account credentials.

**URL Parameters:**
| Parameter | Description |
|-----------|-------------|
| `accountId` | The account ID for credential lookup. Use `default` for the default account, or a specific account ID (e.g., `work`, `personal`, `oauth`). |
| `slug` | Integration slug — matches the folder name in `~/sulla/integrations/` (e.g., `youtube`, `github`, `postmark`). |
| `endpoint` | Endpoint name as defined in the YAML endpoint file (e.g., `search`, `email-send`, `records-list`). |

**Request Body:**
```json
{
  "params": {
    "q": "cats",
    "maxResults": 5
  },
  "body": {},
  "raw": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `params` | `object` | Query parameters and path parameters merged into a single object. |
| `body` | `object` | Request body for POST/PUT/PATCH endpoints. |
| `raw` | `boolean` | When `true`, returns the raw JSON response instead of extracting paginated items. |

**Success Response:**
```json
{
  "success": true,
  "result": {
    "items": [...],
    "nextPageToken": "abc123",
    "raw": { ... }
  }
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Integration \"foo\" not found. Available: youtube, github, postmark"
}
```

**Examples:**

```bash
# Search YouTube with default account credentials
curl -X POST http://localhost:3000/v1/integrations/default/youtube/search/call \
  -H "Content-Type: application/json" \
  -d '{"params": {"q": "funny cats", "maxResults": 5}}'

# Send an email via Postmark with a specific account
curl -X POST http://localhost:3000/v1/integrations/work/postmark/email-send/call \
  -H "Content-Type: application/json" \
  -d '{
    "body": {
      "From": "hello@example.com",
      "To": "jane@example.com",
      "Subject": "Hello",
      "TextBody": "Hi Jane!"
    }
  }'

# Query Attio CRM records with path params
curl -X POST http://localhost:3000/v1/integrations/default/attio/records-list/call \
  -H "Content-Type: application/json" \
  -d '{
    "params": {"object": "people"},
    "body": {"limit": 25}
  }'
```

## Credential Resolution

When an API call is made, credentials are resolved in this order:

1. **IntegrationService DB** — Looks up credentials stored in PostgreSQL for the given `(slug, accountId, property)`. This is where API keys, bearer tokens, and other credentials saved through the UI are stored.
2. **OAuth tokens** — For integrations with `auth.type: oauth2`, the system retrieves and auto-refreshes OAuth access tokens via `OAuthService`.
3. **YAML `${ENV_VAR}` references** — Falls back to environment variable substitution defined in the auth YAML file.

### Account IDs

Each integration can have multiple accounts with different credentials. Common account IDs:

| Account ID | Usage |
|------------|-------|
| `default` | The first account created, or explicitly set as active |
| `oauth` | OAuth-authenticated accounts (Gmail, Google Drive, etc.) |
| Custom IDs | User-defined labels like `work`, `personal`, `client_a` |

The model can discover available accounts using the `list_integration_accounts` native tool (see [Tools Documentation](../development/tools.md)).

## Python Usage

```python
import requests

# Discover available integrations
r = requests.get("http://localhost:3000/v1/integrations")
integrations = r.json()["integrations"]

for integration in integrations:
    print(f"{integration['slug']}: {len(integration['endpoints'])} endpoints")

# Call YouTube search
r = requests.post(
    "http://localhost:3000/v1/integrations/default/youtube/search/call",
    json={"params": {"q": "machine learning", "maxResults": 10}}
)
data = r.json()
if data["success"]:
    for item in data["result"]["items"]:
        print(item["snippet"]["title"])

# Send a Postmark email
r = requests.post(
    "http://localhost:3000/v1/integrations/work/postmark/email-send/call",
    json={
        "body": {
            "From": "team@example.com",
            "To": "user@example.com",
            "Subject": "Report Ready",
            "HtmlBody": "<h1>Your report is ready</h1>",
            "Tag": "reports"
        }
    }
)
print(r.json())
```

## MCP Server Integrations

MCP (Model Context Protocol) servers are a special integration type. Unlike REST integrations which have static YAML endpoint definitions, MCP tools are **discovered dynamically** from connected servers at runtime.

MCP tools appear in the `GET /v1/integrations` response under slug `mcp` and are called using the same `POST /v1/integrations/:accountId/mcp/:toolName/call` pattern.

For full details, see the dedicated [MCP Integration](./mcp.md) documentation.

**Quick example:**
```bash
# Call an MCP tool
curl -X POST http://localhost:3000/v1/integrations/default/mcp/get_weather/call \
  -H "Content-Type: application/json" \
  -d '{"params": {"location": "San Francisco"}}'
```

## Agent Skill

The `discover-and-call-integrations` skill teaches agents the full workflow for using the integration API:
1. Discover available integrations and endpoints
2. Search by keyword
3. Read YAML configs for detailed parameter info
4. Call endpoints with proper parameters
5. Handle MCP tool discovery and execution

Agents load this skill automatically when they need to interact with any integration.

## Error Handling

| HTTP Status | Meaning |
|-------------|---------|
| 200 | Success — check `success` field in response body |
| 404 | Integration or endpoint not found |
| 500 | API call failed (auth error, upstream API error, etc.) |

All error responses include a `success: false` field and an `error` string with details.
