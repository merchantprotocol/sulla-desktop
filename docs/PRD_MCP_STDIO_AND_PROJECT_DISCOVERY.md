# PRD: MCP stdio Transport & Project-Level Server Discovery

## Status: Proposed
## Priority: Critical
## Date: 2026-03-23

---

## Problem Statement

Sulla Desktop currently only supports MCP servers over HTTP/SSE transports, configured manually through the UI. The broader AI tooling ecosystem (Claude Code, Claude Desktop, Cursor, Windsurf, VS Code) has converged on a standard where MCP servers are primarily **local processes launched via stdio transport**, configured through **project-level `.mcp.json` files**. This means Sulla Desktop cannot use the vast majority of community MCP servers, including:

- `mcp-wordpress` (59 tools for WordPress management)
- `@modelcontextprotocol/server-filesystem` (file operations)
- `@modelcontextprotocol/server-github` (GitHub integration)
- Any `npx`-based MCP server (90%+ of the ecosystem)

Without stdio support, Sulla Desktop is locked out of the MCP ecosystem that every other AI tool supports.

---

## Industry Standard Analysis

### The De Facto Configuration Format

5 of 6 major AI tools use the same `mcpServers` object format:

```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "npx",
      "args": ["-y", "mcp-wordpress"],
      "env": {
        "WORDPRESS_SITE_URL": "https://localhost",
        "WORDPRESS_USERNAME": "user@example.com",
        "WORDPRESS_PASSWORD": "app-password-here"
      }
    }
  }
}
```

For HTTP/SSE servers, the format extends to:

```json
{
  "mcpServers": {
    "<server-name>": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer token123"
      }
    }
  }
}
```

### Tool-by-Tool Comparison

| Feature | Claude Desktop | Claude Code | Cursor | Windsurf | VS Code | **Sulla (current)** |
|---------|---------------|-------------|--------|----------|---------|---------------------|
| Root key | `mcpServers` | `mcpServers` | `mcpServers` | `mcpServers` | `servers` | DB-only |
| stdio transport | Yes | Yes | Yes | Yes | Yes | **No** |
| HTTP transport | No | Yes | Yes | Yes | Yes | Yes |
| SSE transport | No | Yes | Yes | Yes | Yes | Yes |
| Project `.mcp.json` | No | Yes | Yes (`.cursor/mcp.json`) | No | Yes (`.vscode/mcp.json`) | **No** |
| User-level config | Yes | Yes (`~/.claude.json`) | Yes (`~/.cursor/mcp.json`) | Yes | Yes | Yes (DB) |
| Env var interpolation | No | `${VAR}` syntax | No | Yes | `${input:id}` | No |

### Key Takeaway

**stdio + `mcpServers` JSON format is the standard.** VS Code is the only outlier (uses `servers` instead of `mcpServers`). Sulla should read the `mcpServers` format natively so that `.mcp.json` files work across Claude Code, Cursor, and Sulla without modification.

### Emerging Specifications (June 2026 Target)

- **SEP-1649**: Server cards at `/.well-known/mcp.json` for capability advertisement
- **SEP-1960**: Discovery endpoint at `/.well-known/mcp` for broader metadata
- **Discussion #2218 / Issue #2219**: Universal MCP configuration standard proposal
- These are not yet finalized but confirm the direction of `mcpServers` object convergence

---

## Current Sulla Desktop Architecture

### How MCP Works Today

```
User configures MCP server via UI (URL + auth token)
  │
  ▼
IntegrationService stores credentials in PostgreSQL
  │
  ▼
MCPBridge.initializeAll() called on startup
  │
  ▼
MCPClient per account (HTTP/SSE transport only)
  │   ├─ StreamableHTTPClientTransport (default)
  │   └─ SSEClientTransport (fallback)
  │
  ▼
Tools discovered via client.listTools()
  │
  ▼
Exposed through GET /v1/integrations API
```

### Source Files

| File | Purpose |
|------|---------|
| `agent/integrations/mcp/MCPClient.ts` | SDK wrapper — transport selection, connection, tool discovery/execution |
| `agent/integrations/mcp/MCPBridge.ts` | Multi-account coordinator singleton, tool aggregation, call routing |
| `agent/integrations/native/ai_infrastructure.ts` | UI integration definition (lines 4-37) |
| `main/chatCompletionsServer.ts` | HTTP API — merges MCP tools into listing, routes calls |
| `agent/services/IntegrationService.ts` | Database credential management |
| `agent/integrations/configApi/IntegrationConfigLoader.ts` | Skips `mcp/` dir (handled by MCPBridge) |
| `sulla.ts` | Startup hook — calls `MCPBridge.initializeAll()` (lines 214-222) |

---

## Requirements

### P0: stdio Transport Support

MCPClient must support spawning local MCP servers as child processes using `StdioClientTransport`.

#### MCPClient Changes

**New constructor signature:**

The MCPClient currently accepts `(serverUrl, accountId, authToken?)`. It needs to also accept stdio configuration. Two approaches:

**Option A — Overloaded config object (recommended):**

```typescript
interface MCPClientHttpConfig {
  type: 'http';
  serverUrl: string;
  accountId: string;
  authToken?: string;
}

interface MCPClientStdioConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  accountId: string;
  cwd?: string;
}

type MCPClientConfig = MCPClientHttpConfig | MCPClientStdioConfig;
```

**New import required:**

```typescript
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
```

> **Note:** `@modelcontextprotocol/sdk` is already imported in MCPClient.ts (line 8-11) but `StdioClientTransport` is not. The SDK does include this transport — it just needs to be imported. Verify that `@modelcontextprotocol/sdk` is listed as an explicit dependency in `package.json` (currently it may only be available transitively through `@playwright/mcp`).

**Transport creation:**

```typescript
private createStdioTransport(): StdioClientTransport {
  // config is MCPClientStdioConfig
  return new StdioClientTransport({
    command: this.config.command,
    args:    this.config.args || [],
    env:     { ...process.env, ...(this.config.env || {}) },
    cwd:     this.config.cwd,
  });
}
```

**Transport selection update (currently lines 175-180):**

```typescript
private createTransport(): Transport {
  if (this.config.type === 'stdio') {
    return this.createStdioTransport();
  }
  if (this.config.serverUrl.includes('/sse')) {
    return this.createSSETransport();
  }
  return this.createStreamableHTTPTransport();
}
```

**Process lifecycle:**

- `initialize()`: StdioClientTransport spawns the child process automatically on `client.connect(transport)`
- `close()`: StdioClientTransport kills the child process on `transport.close()`
- No additional process management code needed — the SDK handles it

**Fallback behavior:**

- stdio transport does NOT fall back to SSE (unlike HTTP). If stdio fails, it fails.
- Error message should indicate the command that failed: `"Failed to start MCP server: npx -y mcp-wordpress"`

#### MCPBridge Changes

`initializeAccount()` (currently lines 68-87) reads `server_url` and `auth_token` from the database. It needs to also handle stdio config:

```typescript
async initializeAccount(accountId: string): Promise<void> {
  const svc = getIntegrationService();

  // Check for stdio config first
  const commandVal = await svc.getIntegrationValue(INTEGRATION_ID, 'command', accountId);

  if (commandVal?.value) {
    // stdio mode
    const argsVal = await svc.getIntegrationValue(INTEGRATION_ID, 'args', accountId);
    const envVal  = await svc.getIntegrationValue(INTEGRATION_ID, 'env', accountId);

    const client = new MCPClient({
      type:      'stdio',
      command:   commandVal.value,
      args:      argsVal?.value ? JSON.parse(argsVal.value) : [],
      env:       envVal?.value ? JSON.parse(envVal.value) : {},
      accountId,
    });
    await client.initialize();
    this.clients.set(accountId, client);
  } else {
    // HTTP mode (existing behavior)
    const serverUrlVal = await svc.getIntegrationValue(INTEGRATION_ID, 'server_url', accountId);
    const authTokenVal = await svc.getIntegrationValue(INTEGRATION_ID, 'auth_token', accountId);
    // ... existing code ...
  }
}
```

#### UI Changes (ai_infrastructure.ts)

The MCP Server integration definition needs a transport type selector and conditional fields:

```typescript
mcp: {
  id: 'mcp',
  // ... existing fields ...
  properties: [
    {
      key:         'transport_type',
      title:       'Transport Type',
      hint:        'How to connect: HTTP for remote servers, Local Command for stdio-based servers.',
      type:        'select',
      required:    true,
      placeholder: 'Select transport...',
      options:     [
        { value: 'http',  label: 'HTTP / SSE (Remote Server)' },
        { value: 'stdio', label: 'Local Command (stdio)' },
      ],
    },
    // HTTP fields (shown when transport_type === 'http')
    {
      key:         'server_url',
      title:       'Server URL',
      hint:        'The MCP server endpoint URL.',
      type:        'url',
      required:    true,
      placeholder: 'http://localhost:3001/mcp',
      showWhen:    { transport_type: 'http' },
    },
    {
      key:         'auth_token',
      title:       'Auth Token',
      hint:        'Optional bearer token.',
      type:        'password',
      required:    false,
      placeholder: 'Bearer token or API key',
      showWhen:    { transport_type: 'http' },
    },
    // stdio fields (shown when transport_type === 'stdio')
    {
      key:         'command',
      title:       'Command',
      hint:        'The executable to run (e.g., npx, node, python).',
      type:        'text',
      required:    true,
      placeholder: 'npx',
      showWhen:    { transport_type: 'stdio' },
    },
    {
      key:         'args',
      title:       'Arguments',
      hint:        'Command arguments as JSON array (e.g., ["-y", "mcp-wordpress"]).',
      type:        'text',
      required:    false,
      placeholder: '["-y", "mcp-wordpress"]',
      showWhen:    { transport_type: 'stdio' },
    },
    {
      key:         'env',
      title:       'Environment Variables',
      hint:        'JSON object of env vars (e.g., {"API_KEY": "value"}).',
      type:        'textarea',
      required:    false,
      placeholder: '{"WORDPRESS_SITE_URL": "https://localhost"}',
      showWhen:    { transport_type: 'stdio' },
    },
  ],
},
```

> **Note:** The `showWhen` conditional rendering requires support in `AgentIntegrationDetail.vue`. If conditional form fields are not yet implemented, this is a sub-task. Alternatively, keep all fields visible with clear labels and make the bridge smart enough to detect which mode based on which fields are filled.

---

### P1: Project-Level `.mcp.json` File Discovery

Sulla Desktop should automatically discover and load MCP servers defined in `.mcp.json` files found in project directories.

#### File Format

Standard `.mcp.json` (same format used by Claude Code, Cursor):

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "npx",
      "args": ["-y", "mcp-wordpress"],
      "env": {
        "WORDPRESS_SITE_URL": "https://localhost",
        "WORDPRESS_USERNAME": "user@example.com",
        "WORDPRESS_PASSWORD": "${WP_APP_PASSWORD}"
      }
    },
    "simply-static": {
      "command": "node",
      "args": ["/path/to/mcp-simply-static/index.js"],
      "env": {
        "WP_SITE_URL": "https://localhost",
        "WP_USER": "user@example.com",
        "WP_PASS": "password"
      }
    },
    "remote-server": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer token"
      }
    }
  }
}
```

#### New File: `MCPFileDiscovery.ts`

Create `agent/integrations/mcp/MCPFileDiscovery.ts`:

```
Purpose: Watch for and parse .mcp.json files, register discovered servers with MCPBridge

Responsibilities:
1. Scan known project directories for .mcp.json files
2. Parse the mcpServers object
3. For each server entry, determine transport type:
   - Has "command" field → stdio transport
   - Has "url" or "server_url" field → HTTP transport
4. Register each server with MCPBridge as a file-based account
5. Watch for file changes and hot-reload
6. Support ${VAR} environment variable interpolation in values
```

**Account ID namespacing:**

File-discovered servers need unique account IDs that don't collide with UI-configured ones. Use a prefix convention:

```
file:<project-path-hash>:<server-name>
```

Example: `file:a1b2c3:wordpress`

This keeps them separate from UI accounts in the MCPBridge clients map.

#### Environment Variable Interpolation

Support `${VAR}` and `${VAR:-default}` syntax in `.mcp.json` values:

```typescript
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const [varName, defaultVal] = expr.split(':-');
    return process.env[varName.trim()] || defaultVal?.trim() || '';
  });
}
```

This is critical for security — users should never commit secrets in `.mcp.json`. Instead:
```json
{
  "mcpServers": {
    "wordpress": {
      "command": "npx",
      "args": ["-y", "mcp-wordpress"],
      "env": {
        "WORDPRESS_PASSWORD": "${WP_APP_PASSWORD}"
      }
    }
  }
}
```

#### Discovery Sources (Priority Order)

1. **Project directory** — `.mcp.json` at the root of the active project/workspace
2. **User home** — `~/.mcp.json` (global servers available everywhere)
3. **UI-configured** — existing database-stored accounts (unchanged)

When merging, later sources win for same-name servers. UI-configured accounts always take priority over file-based ones.

#### MCPBridge Integration

Add to MCPBridge:

```typescript
/**
 * Load MCP servers from a .mcp.json file.
 * Servers are registered as file-based accounts alongside UI accounts.
 */
async loadFromFile(filePath: string, projectId: string): Promise<void> {
  // 1. Read and parse .mcp.json
  // 2. For each entry in mcpServers:
  //    a. Determine transport type (stdio vs http)
  //    b. Interpolate env vars
  //    c. Create MCPClient with config
  //    d. Initialize and add to clients map
  // 3. Log which servers were loaded from which file
}

/**
 * Unload all file-based servers for a given project.
 */
async unloadFileServers(projectId: string): Promise<void> {
  // Close and remove all clients whose accountId starts with file:<projectId>:
}
```

#### Startup Integration (sulla.ts)

After the existing `MCPBridge.initializeAll()` call (line ~220), add file discovery:

```typescript
// Existing: initialize UI-configured MCP accounts
await MCPBridge.getInstance().initializeAll();

// New: discover .mcp.json files
const discovery = new MCPFileDiscovery();
await discovery.scanAndLoad();
```

#### File Watcher

Use `fs.watch` or `chokidar` to watch `.mcp.json` files for changes. On change:
1. Unload all servers from that file
2. Re-parse and re-load

This enables hot-reload when a user edits their `.mcp.json`.

---

### P2: Unified Tool Listing

File-discovered MCP servers must appear in the same tool listing API as UI-configured ones. No API changes needed — MCPBridge.getAllEndpoints() already iterates all clients in its map. File-based accounts will appear automatically as long as they're added to the `clients` Map.

The `accountId` prefix (`file:...`) distinguishes them in the listing so callers know the source.

---

### P2: UI Indicator for File-Discovered Servers

In the Integrations page, show file-discovered MCP servers as read-only entries with a badge indicating their source:

```
┌──────────────────────────────────────┐
│ MCP Server: wordpress               │
│ Source: .mcp.json (project)          │
│ Transport: stdio (npx mcp-wordpress) │
│ Tools: 59 discovered                │
│ Status: Connected ●                  │
│                                      │
│ [Read-only — edit .mcp.json to      │
│  change configuration]               │
└──────────────────────────────────────┘
```

This is non-blocking — the servers work through the API regardless of UI representation.

---

## Implementation Plan

### Phase 1: stdio Transport (P0)

**Files to modify:**

| File | Changes |
|------|---------|
| `agent/integrations/mcp/MCPClient.ts` | Add `MCPClientConfig` type union, `StdioClientTransport` import, `createStdioTransport()` method, refactor constructor to accept config object |
| `agent/integrations/mcp/MCPBridge.ts` | Update `initializeAccount()` to detect stdio vs HTTP config, pass appropriate config to MCPClient |
| `agent/integrations/native/ai_infrastructure.ts` | Add `transport_type`, `command`, `args`, `env` fields to MCP integration properties |
| `pages/AgentIntegrationDetail.vue` | Conditional field rendering based on `transport_type` (if not already supported) |
| `package.json` | Verify `@modelcontextprotocol/sdk` is an explicit dependency (not just transitive) |

**Estimated scope:** ~200 lines changed across 3-4 files.

### Phase 2: `.mcp.json` Discovery (P1)

**Files to create:**

| File | Purpose |
|------|---------|
| `agent/integrations/mcp/MCPFileDiscovery.ts` | File parser, env interpolation, watcher, bridge integration |

**Files to modify:**

| File | Changes |
|------|---------|
| `agent/integrations/mcp/MCPBridge.ts` | Add `loadFromFile()`, `unloadFileServers()` methods |
| `sulla.ts` | Add file discovery initialization after MCPBridge.initializeAll() |

**Estimated scope:** ~300 lines new, ~50 lines changed.

### Phase 3: UI Enhancements (P2)

**Files to modify:**

| File | Changes |
|------|---------|
| `pages/AgentIntegrations.vue` | Show file-discovered servers as read-only cards |
| `agent/integrations/mcp/MCPBridge.ts` | Add method to distinguish file vs UI accounts |

**Estimated scope:** ~100 lines changed.

---

## Testing Checklist

### stdio Transport
- [ ] Can connect to an `npx`-based MCP server (e.g., `npx -y @modelcontextprotocol/server-filesystem /tmp`)
- [ ] Can connect to a `node`-based MCP server (local script)
- [ ] Child process is killed on disconnect/close
- [ ] Child process is killed on Sulla Desktop shutdown
- [ ] Environment variables are passed to child process
- [ ] Tool discovery works identically to HTTP transport
- [ ] Tool execution works identically to HTTP transport
- [ ] Errors from failed process spawn are reported clearly
- [ ] UI allows configuring stdio-based servers via transport type selector

### `.mcp.json` Discovery
- [ ] Finds and loads `.mcp.json` from project root
- [ ] Finds and loads `~/.mcp.json` from home directory
- [ ] stdio servers in `.mcp.json` launch correctly
- [ ] HTTP servers in `.mcp.json` connect correctly
- [ ] `${VAR}` interpolation resolves from system environment
- [ ] `${VAR:-default}` fallback works
- [ ] File changes trigger hot-reload (servers restart)
- [ ] File-discovered servers appear in GET /v1/integrations
- [ ] File-discovered servers can be called via POST /v1/integrations/{accountId}/mcp/{tool}/call
- [ ] UI-configured accounts take priority over file-based for same name
- [ ] Removing a `.mcp.json` file disconnects its servers

### Cross-Compatibility
- [ ] Same `.mcp.json` file works in both Claude Code and Sulla Desktop
- [ ] Same `.mcp.json` file works in both Cursor and Sulla Desktop
- [ ] WordPress MCP server (`mcp-wordpress`) tools are accessible
- [ ] Custom Simply Static MCP server tools are accessible

---

## Example: WordPress MCP Setup After Implementation

A user with this `.mcp.json` in their project root:

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "npx",
      "args": ["-y", "mcp-wordpress"],
      "env": {
        "WORDPRESS_SITE_URL": "https://localhost",
        "WORDPRESS_USERNAME": "jonathonbyrd@gmail.com",
        "WORDPRESS_PASSWORD": "${WP_APP_PASSWORD}",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    },
    "simply-static": {
      "command": "node",
      "args": ["/Users/jonathonbyrdziak/Sites/merchantprotocol/mcp-simply-static/index.js"],
      "env": {
        "WP_SITE_URL": "https://localhost",
        "WP_USER": "jonathonbyrd@gmail.com",
        "WP_PASS": "${WP_PASS}"
      }
    }
  }
}
```

Would automatically have 64+ tools available in Sulla Desktop:
- 59 WordPress tools (posts, pages, media, taxonomy, plugins, SEO)
- 5 Simply Static tools (start_export, check_status, generate, get_settings, get_log)

The same file works in Claude Code, Cursor, and Sulla Desktop with zero modification.

---

## Dependencies

- `@modelcontextprotocol/sdk` must be an explicit dependency in `package.json` (verify — may currently be transitive only via `@playwright/mcp`)
- `StdioClientTransport` is available in the SDK at `@modelcontextprotocol/sdk/client/stdio.js`
- Node.js `child_process` is used internally by StdioClientTransport (no additional deps)
- `chokidar` (optional) for robust file watching, or use native `fs.watch`

---

## References

- [MCP Specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP TypeScript SDK — StdioClientTransport](https://github.com/modelcontextprotocol/typescript-sdk)
- [Claude Code MCP Configuration](https://code.claude.com/docs/en/mcp)
- [Cursor MCP Configuration](https://cursor.com/docs/context/mcp)
- [VS Code MCP Configuration](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)
- [Windsurf MCP Configuration](https://docs.windsurf.com/windsurf/cascade/mcp)
- [MCP Registry](https://registry.modelcontextprotocol.io)
- [Proposal: Universal MCP Config Standard (Discussion #2218)](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2218)
- [SEP-1649: Server Cards Discovery](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649)
- [SEP-1960: Well-Known Discovery](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1960)
