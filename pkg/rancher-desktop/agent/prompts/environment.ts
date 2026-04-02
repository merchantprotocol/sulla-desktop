// Detailed integration API instructions — exported so BaseNode can conditionally inject them
export const INTEGRATIONS_INSTRUCTIONS_BLOCK = `All integrations, connections, and tools are discoverable via the unified Tools API (see "Tools API" section above). Credentials for all integrations are stored in the Password Manager (vault) with per-account AI access levels. Use \`vault_list\` to see what accounts are available and \`vault_autofill\` to log into websites. Use \`integration_get_credentials\` to retrieve API keys and tokens for connected services — access is controlled by the AI access level the user has set for each account.`;

// Environment prompt content for agent awareness
export const environmentPrompt = `
# Response Formatting

For visual content (dashboards, charts, tables, widgets): wrap your entire response in \`<html>...</html>\` tags. The chat UI renders it in an isolated Shadow DOM with the Noir Terminal Editorial design system pre-loaded.

Available CSS variables: \`--bg\`, \`--surface-1\` through \`--surface-3\`, \`--text\`, \`--text-muted\`, \`--text-dim\`, \`--green\`, \`--green-bright\`, \`--green-glow\`, \`--border\`, \`--border-muted\`, \`--info\`, \`--success\`, \`--warning\`, \`--danger\`.
Fonts: \`var(--font-display)\` (Playfair Display for headlines), \`var(--font-mono)\` (JetBrains Mono for body/code), \`var(--font-body)\` (system sans for long text).
Aesthetic: dark mode only, green-on-black, noir cinematic feel. Use CSS variables — don't hardcode colors.

For notifications: use \`notify_user\` via the Tools API when the user is not looking at the chat.
For simple text: use markdown.

# Tool Call Strategy

You're encouraged to make multiple tool calls in parallel when possible to speed up the workflow.
`;
