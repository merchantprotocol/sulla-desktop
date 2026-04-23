/**
 * Tooling Section — Tool-first rule, capabilities, and tool usage guidance.
 * Priority: 40
 * Modes: full, minimal
 *
 * Migrated from AGENT_PROMPT_BASE in AgentNode.ts.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildToolingSection(ctx: PromptBuildContext): PromptSection | null {
  const toolCategories = ctx.templateVars['{{tool_categories}}'] || '';

  if (ctx.mode === 'local') {
    const content = `## Tools

All integrations, MCP servers, and internal tools are callable through the \`sulla\` CLI. The system handles authentication — credentials are resolved from the encrypted vault and injected automatically.

\`\`\`bash
# Proxy call — authenticated API pass-through to any service
sulla <account_id>/<slug> '{"method":"GET","path":"/rest/companies"}'

# Internal tool — built-in tools organized by category
sulla <category>/<tool> '{"param":"value"}'

# MCP tool — Model Context Protocol servers
sulla <account_id>/mcp/<tool> '{"param":"value"}'
\`\`\`

Make parallel tool calls when possible.`;

    return {
      id:             'tooling',
      content,
      priority:       40,
      cacheStability: 'stable',
    };
  }

  const content = `## Your App

Your tools are provided as function calls in this conversation. They are already loaded and ready to use.

- **Calendar** — schedule, list, update, and cancel events
- **Password Vault** — all your and the humans passwords and API keys live here; never hardcode secrets
- **Browser** — full Playwright and Chrome automation for web interaction
- **Docker & Extensions** — run containers, install/uninstall extensions, access extension UIs through the browser
- **Code Execution** — run any shell command via \`exec\` inside the VM
- **Extensions** — pre-built applications that extend your capabilities

All capabilities are available through your tools.

## Tools

All integrations, MCP servers, and internal tools are callable through the \`sulla\` CLI. The system handles authentication — credentials are resolved from the encrypted vault and injected automatically.

\`\`\`bash
# Proxy call — authenticated API pass-through to any service
sulla <account_id>/<slug> '{"method":"GET","path":"/rest/companies"}'

# Internal tool — built-in tools organized by category
sulla <category>/<tool> '{"param":"value"}'

# MCP tool — Model Context Protocol servers
sulla <account_id>/mcp/<tool> '{"param":"value"}'
\`\`\`

**CRITICAL — tool dispatch rule:**
- ✅ ALWAYS use \`exec({ command: "sulla <category>/<tool> '...'" })\` to run CLI tools
- ❌ NEVER use \`execute_workflow\` for CLI tools — it only handles named n8n/Sulla workflows and will always fail otherwise

Make parallel tool calls when possible.`;

  return {
    id:             'tooling',
    content,
    priority:       40,
    cacheStability: 'stable',
  };
}
