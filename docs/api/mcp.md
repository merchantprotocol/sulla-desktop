# MCP (Model Context Protocol) Integration

## Overview

Sulla supports connecting to external MCP servers, allowing agents to discover and call tools exposed by any MCP-compatible server. MCP tools are dynamically discovered at runtime and exposed through the same HTTP integration API as REST integrations.

Each MCP server connection is an "account" under the `mcp` integration. You can connect multiple MCP servers simultaneously — each with its own URL and optional auth token.

## Architecture

```
User configures MCP server (URL + auth token) via UI
  |
  v
IntegrationService stores credentials (PostgreSQL)
  |
  v
MCPBridge initializes MCPClient per account
  |
  v
MCPClient connects via MCP SDK (@modelcontextprotocol/sdk)
  |   - Transport: StreamableHTTP (default) or SSE (fallback)
  |   - Auth: Bearer token in request headers
  v
MCPClient.listTools() discovers available tools
  |
  v
Tools exposed via GET /v1/integrations (under slug "mcp")
  |
  v
Agent calls POST /v1/integrations/{accountId}/mcp/{toolName}/call
  |
  v
MCPBridge routes to correct MCPClient
  |
  v
MCPClient.callTool() sends JSON-RPC request to MCP server
```

## Configuration

### UI Setup

1. Go to **Integrations** in Sulla Desktop
2. Find **MCP Server** under the **AI Infrastructure** category
3. Enter the server URL and optional auth token
4. Click Connect

Each connection creates a separate account. You can add multiple MCP servers by creating additional accounts.

### Integration Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `server_url` | URL | Yes | MCP server endpoint (e.g., `http://localhost:3001/mcp` or `https://mcp.example.com/sse`) |
| `auth_token` | Password | No | Bearer token for authenticating with the MCP server |

### YAML Auth Config

Located at `~/sulla/integrations/mcp/mcp.v1-auth.yaml`. This file provides the base auth config for the MCP integration. Actual server URLs and tokens are stored per-account in the IntegrationService database.

```yaml
api:
  name: mcp-v1
  version: v1
  provider: mcp
  base_url: "http://localhost"

auth:
  type: bearer
  client_secret: "${MCP_AUTH_TOKEN}"
  token_storage: local
  refresh_automatically: false
```

## Transport Selection

The MCPClient automatically selects the appropriate transport:

| Condition | Transport Used |
|-----------|---------------|
| URL contains `/sse` | `SSEClientTransport` |
| Default | `StreamableHTTPClientTransport` |
| StreamableHTTP fails | Falls back to `SSEClientTransport` |

Both transports support bearer token authentication via request headers.

StreamableHTTP reconnection is configured with:
- Initial delay: 1 second
- Max delay: 30 seconds
- Growth factor: 1.5x
- Max retries: 3

## API Endpoints

### Discovery

MCP tools appear in the standard integration listing:

```bash
curl http://localhost:3000/v1/integrations
```

Response includes MCP tools under the `mcp` slug:

```json
{
  "success": true,
  "integrations": [
    {
      "slug": "mcp",
      "name": "mcp-v1",
      "endpoints": [
        {
          "name": "get_weather",
          "method": "POST",
          "path": "/tools/call",
          "description": "Get weather forecast for a location",
          "auth": "required",
          "queryParams": [
            {
              "name": "location",
              "type": "string",
              "required": true,
              "description": "City name or coordinates"
            }
          ],
          "pathParams": [],
          "accountId": "default"
        }
      ]
    }
  ]
}
```

Each endpoint includes an `accountId` field identifying which MCP server provides that tool. This is important when multiple MCP servers are connected.

### Calling an MCP Tool

```bash
curl -X POST http://localhost:3000/v1/integrations/{accountId}/mcp/{toolName}/call \
  -H "Content-Type: application/json" \
  -d '{"params": {"location": "San Francisco"}}'
```

**URL Parameters:**

| Parameter | Description |
|-----------|-------------|
| `accountId` | The MCP server account ID (from the discovery listing's `accountId` field, or `default`) |
| `toolName` | The MCP tool name (from the discovery listing's `name` field) |

**Request Body:**

```json
{
  "params": {
    "key": "value"
  }
}
```

The `params` object is passed directly as `arguments` to the MCP server's `tools/call` JSON-RPC method.

**Success Response:**

```json
{
  "success": true,
  "result": {
    "success": true,
    "content": [
      {
        "type": "text",
        "text": "Weather in San Francisco: 65°F, partly cloudy"
      }
    ],
    "isError": false,
    "raw": { ... }
  }
}
```

**Error Response:**

```json
{
  "success": false,
  "error": "No MCP client for account \"default\". Connected accounts: none"
}
```

### Response Content Types

MCP tools return content arrays. Each item has a `type` field:

| Type | Fields | Description |
|------|--------|-------------|
| `text` | `text` | Plain text content |
| `image` | `data`, `mimeType` | Base64-encoded image |
| `audio` | `data`, `mimeType` | Base64-encoded audio |
| `resource` | `resource.uri`, `resource.text` or `resource.blob` | Embedded resource |
| `resource_link` | `uri`, `name`, `description` | Link to a resource |

## Python Usage

```python
import requests, json

# 1. Discover MCP tools
r = requests.get("http://localhost:3000/v1/integrations")
integrations = r.json()["integrations"]
mcp = next((i for i in integrations if i["slug"] == "mcp"), None)

if mcp:
    print("MCP Tools:")
    for ep in mcp["endpoints"]:
        account = ep.get("accountId", "default")
        print(f"  [{account}] {ep['name']}: {ep['description']}")
        for p in ep.get("queryParams", []):
            req = "*" if p.get("required") else ""
            print(f"    - {p['name']}{req} ({p['type']}): {p.get('description', '')}")

# 2. Call an MCP tool
r = requests.post(
    "http://localhost:3000/v1/integrations/default/mcp/get_weather/call",
    json={"params": {"location": "San Francisco"}},
    headers={"Content-Type": "application/json"}
)
result = r.json()

if result["success"]:
    for content in result["result"]["content"]:
        if content["type"] == "text":
            print(content["text"])
else:
    print(f"Error: {result.get('error')}")
```

## Multiple MCP Servers

When multiple MCP servers are connected, each has its own account ID. Tools from different servers may have the same name — use the `accountId` from the discovery listing to route to the correct server.

```python
import requests

r = requests.get("http://localhost:3000/v1/integrations")
mcp = next((i for i in r.json()["integrations"] if i["slug"] == "mcp"), None)

if mcp:
    # Group tools by account
    by_account = {}
    for ep in mcp["endpoints"]:
        acct = ep.get("accountId", "default")
        by_account.setdefault(acct, []).append(ep["name"])

    for account_id, tools in by_account.items():
        print(f"\nServer [{account_id}]: {', '.join(tools)}")

    # Call a tool on a specific server
    r = requests.post(
        f"http://localhost:3000/v1/integrations/my-server-account/mcp/search/call",
        json={"params": {"query": "example"}},
        headers={"Content-Type": "application/json"}
    )
    print(r.json())
```

## Source Files

| File | Purpose |
|------|---------|
| `~/sulla/integrations/mcp/mcp.v1-auth.yaml` | YAML auth config (base config, per-account values in DB) |
| `agent/integrations/mcp/MCPClient.ts` | SDK wrapper — transport, connection, tool discovery, tool execution |
| `agent/integrations/mcp/MCPBridge.ts` | Multi-account coordinator singleton |
| `agent/integrations/native/ai_infrastructure.ts` | UI integration definition (MCP Server entry) |
| `main/chatCompletionsServer.ts` | HTTP API — merges MCP into listing, routes MCP calls |
| `agent/integrations/configApi/IntegrationConfigLoader.ts` | Skips `mcp/` dir (handled by MCPBridge) |

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| MCP tools don't appear in listing | MCPBridge not initialized or no accounts connected | Verify the MCP integration is connected in the UI |
| "No MCP client for account" error | Account ID doesn't match a connected server | Check `accountId` values in the discovery listing |
| Connection timeout | Server unreachable or wrong URL | Verify the MCP server is running and the URL is correct |
| StreamableHTTP fails, SSE works | Server only supports SSE transport | Add `/sse` to the server URL or let the auto-fallback handle it |
| Auth errors | Missing or invalid token | Check the auth token in the integration settings |
