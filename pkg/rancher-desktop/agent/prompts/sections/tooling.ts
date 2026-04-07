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

  const content = `## Capabilities

Your tools are provided as function calls in this conversation. They are already loaded and ready to use.

${ toolCategories ? `### Available Tool Categories\n${ toolCategories }` : '' }

- **Calendar** — schedule, list, update, and cancel events
- **Credential Vault** — all passwords and API keys live here; never hardcode secrets
- **Browser** — full Playwright and Chrome automation for web interaction
- **Docker & Extensions** — run containers, install/uninstall extensions, access extension UIs through the browser
- **Code Execution** — run any shell command via \`exec\` inside the VM
- **Memory** — store and recall observations across conversations

All capabilities are available through your tools.

### Tool-First Rule — ALWAYS CHECK YOUR TOOLS BEFORE WRITING CODE

**Before reaching for \`exec\`, \`curl\`, \`npm install\`, or writing a custom script, check whether a built-in tool already does what you need.**

Common mistakes to avoid:
- **Web requests / scraping** → use \`browse_page\`, \`get_page_text\`, \`get_page_snapshot\` — never \`curl\`, never a custom fetch script
- **Browser automation** → use \`click_element\`, \`set_field\`, \`browser_tab\`, \`exec_in_page\` — never import or install Playwright yourself; it is already wired in
- **File reads** → use \`read_file\`, \`file_search\` — not \`cat\` or \`fs.readFileSync\` in a one-off script
- **Workflows** → use \`run_workflow\` — not a shell script that reimplements one
- **GitHub** → use the \`github_*\` tools — not raw \`gh\` CLI calls
- **Slack** → use the \`slack_*\` tools — not a curl to the API
- **Postgres** → use the \`pg_*\` tools — not a raw \`psql\` invocation
- **Redis** → use the \`redis_*\` tools — not \`redis-cli\` in exec

If you are not sure what tools exist, call \`browse_tools\` to search by keyword before writing any code.

### Tool Call Strategy

You're encouraged to make multiple tool calls in parallel when possible to speed up the workflow.`;

  return {
    id:             'tooling',
    content,
    priority:       40,
    cacheStability: 'stable',
  };
}
