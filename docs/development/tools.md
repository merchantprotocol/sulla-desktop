# Tools System

## Overview

Sulla's tool system gives the AI model the ability to take actions — read files, send Slack messages, query databases, manage integrations, and more. Tools are organized by category, lazily loaded on demand, and discovered by the model at runtime through `browse_tools`.

The model interacts with tools through a structured JSON interface. When the model needs a tool, it first calls `browse_tools` to discover what's available, then calls the tool by name with a JSON arguments object.

**Source:** `pkg/rancher-desktop/agent/tools/`

## Architecture

```
tools/
  registry.ts          ← ToolRegistry singleton (central hub)
  base.ts              ← BaseTool class (all tools extend this)
  manifests.ts         ← Central registration point (imports all category manifests)
  meta/                ← Discovery & control tools
    manifests.ts       ← Manifest definitions for this category
    browse_tools.ts    ← Tool discovery
    exec.ts            ← Shell command execution
    ...
  fs/                  ← File system tools
  slack/               ← Slack tools
  github/              ← GitHub tools
  integrations/        ← Integration management tools
  ...
```

## Tool Categories

| Category | Description | Key Tools |
|----------|-------------|-----------|
| `meta` | Discovery, memory, execution | `browse_tools`, `exec`, `add_observational_memory`, `meta_search` |
| `slack` | Slack messaging | `slack_send_message`, `slack_search_users`, `slack_connection_health` |
| `github` | GitHub operations | Repository, PR, issue management |
| `n8n` | Workflow automation (complex ops) | `patch_workflow`, `validate_workflow`, `diagnose_webhook`, `restart_n8n_container` |
| `docker` | Container management | Container and image operations |
| `kubectl` | Kubernetes | Cluster management |
| `integrations` | Integration credentials & accounts | `integration_get_credentials`, `list_integration_accounts`, `set_active_integration_account` |
| `playwright` | Web interaction | `click_element`, `fill_form`, `scroll`, `read_dom` |
| `skills` | Reusable skills | Search, load, create skills |
| `workspace` | Workspace management | Folder operations |
| `redis` | Redis operations | Key-value store operations |
| `pg` | PostgreSQL | Database queries |
| `bridge` | Frontend communication | Message bridge with UI |
| `calendar` | Calendar events | Event management |
| `extensions` | Extension marketplace | Browse, install, uninstall extensions |
| `workflow` | Workflow execution & recovery | `execute_workflow`, `restart_from_checkpoint` |
| `rdctl` | Sulla/rdctl commands | Desktop management |
| `lima` | Lima VM | VM instance management |

## Creating a New Tool

### Step 1: Create the Worker Class

Create a file in the appropriate category directory, e.g., `tools/mycat/my_tool.ts`:

```typescript
import { BaseTool, ToolResponse } from "../base";

export class MyToolWorker extends BaseTool {
  name: string = '';        // Populated by registry from manifest
  description: string = ''; // Populated by registry from manifest

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { query, limit } = input;

    try {
      // Your tool logic here
      const results = await doSomething(query, limit);

      return {
        successBoolean: true,
        responseString: JSON.stringify(results),
      };
    } catch (error: any) {
      return {
        successBoolean: false,
        responseString: `Failed: ${error.message}`,
      };
    }
  }
}
```

**Key points:**
- Extend `BaseTool`
- Leave `name` and `description` empty — the registry sets them from the manifest
- Implement `_validatedCall(input)` — input is already parsed and validated against your schema
- Return `{ successBoolean, responseString }` — the string is what the model sees

### Step 2: Create the Manifest

Add your tool to the category's `manifests.ts` file (or create one):

```typescript
import type { ToolManifest } from '../registry';

export const myCatToolManifests: ToolManifest[] = [
  {
    name: 'my_tool',
    description: 'Search for something and return results.',
    category: 'mycat',
    schemaDef: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return',
        optional: true,
        default: 10,
      },
    },
    operationTypes: ['read'],
    loader: () => import('./my_tool'),
  },
];
```

### Step 3: Register the Manifest

Add your manifests to the central registration file `tools/manifests.ts`:

```typescript
import { myCatToolManifests } from './mycat/manifests';

toolRegistry.registerManifests([
  // ... existing manifests
  ...myCatToolManifests,
]);
```

### Step 4: Add the Category

If this is a new category, add it to the `categoriesList` in `tools/registry.ts`.

## Manifest Reference

### ToolManifest

```typescript
interface ToolManifest {
  name: string;                            // Unique tool name (e.g., 'patch_workflow')
  description: string;                     // Shown to the model during discovery
  category: string;                        // Category for grouping
  schemaDef: Record<string, FieldSchema>;  // Input parameter definitions
  operationTypes?: ToolOperation[];        // What the tool does
  loader: () => Promise<any>;              // Dynamic import for lazy loading
}
```

### FieldSchema

```typescript
interface FieldSchema {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';
  description?: string;
  optional?: boolean;        // Default: false (required)
  default?: unknown;
  enum?: string[];           // For type 'enum'
  items?: FieldSchema;       // For type 'array'
  nullable?: boolean;
  properties?: Record<string, FieldSchema>;  // For type 'object'
}
```

### Operation Types

```typescript
type ToolOperation = 'read' | 'create' | 'update' | 'delete' | 'execute';
```

Used for filtering during tool discovery. A model can request tools by operation type:
- `read` — retrieves data without side effects
- `create` — creates new resources
- `update` — modifies existing resources
- `delete` — removes resources
- `execute` — runs commands or processes

## How the Model Discovers Tools

1. The model calls `browse_tools` with optional filters (category, query, operationType)
2. The registry searches matching tools and returns their names, descriptions, and JSON schemas
3. Matching tools are attached to the model's `state.llmTools` so it can call them directly
4. The model calls the tool by name with a JSON arguments object
5. Results are appended to the conversation as tool response messages

```
Model → browse_tools(category: "slack")
     ← Found 3 tools: slack_send_message, slack_search_users, ...
Model → slack_send_message({ channel: "#general", text: "Hello" })
     ← { success: true, result: "Message sent" }
```

## Tool Response Format

```typescript
interface ToolResponse {
  successBoolean: boolean;   // Did the tool succeed?
  responseString: string;    // Text response shown to the model
}
```

The `responseString` is what the model sees. Keep it concise and structured — the model processes this to decide its next action.

## Advanced Features

### State Access

Tools can access the execution state (thread metadata, WebSocket channel, etc.):

```typescript
protected async _validatedCall(input: any): Promise<ToolResponse> {
  const threadId = this.state?.metadata?.threadId;
  // ...
}
```

### Progress Updates

Tools can send real-time progress to the frontend:

```typescript
protected async _validatedCall(input: any): Promise<ToolResponse> {
  this.sendChatMessage?.('Processing step 1...', 'progress');
  await doStep1();
  this.sendChatMessage?.('Processing step 2...', 'progress');
  await doStep2();
  // ...
}
```

### Lazy Loading

Tools use dynamic `import()` in manifests. The worker class is only loaded when the tool is first called, keeping startup fast:

```typescript
loader: () => import('./my_expensive_tool'),
```

## Integration Management Tools

These tools let the model manage integration credentials and accounts:

| Tool | Description |
|------|-------------|
| `integration_list` | List all available integrations and their connection status |
| `integration_get_credentials` | Retrieve credentials for an integration (all accounts, with masking) |
| `integration_is_enabled` | Check if an integration is connected |
| `list_integration_accounts` | List all accounts for an integration with active account marked |
| `set_active_integration_account` | Switch which account is used by default |

The model uses these tools to understand what credentials are available, then uses the account IDs when calling the [Integrations API](../api/integrations.md) endpoints.
