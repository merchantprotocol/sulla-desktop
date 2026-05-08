// Detailed integration API instructions — exported so BaseNode can conditionally inject them
export const INTEGRATIONS_INSTRUCTIONS_BLOCK = `All integrations, connections, and tools are discoverable via the unified Tools API (see "Tools API" section above). Credentials for all integrations are stored in the Password Manager (vault) with per-account AI access levels. Use \`vault/list\` to see what accounts are available and \`vault/autofill\` to log into websites. Use \`vault/read_secrets\` to retrieve API keys and tokens for connected services — access is controlled by the AI access level the user has set for each account.`;

// Environment prompt content for agent awareness
export const environmentPrompt = `
# Response Formatting

For visual content (dashboards, charts, tables, widgets): wrap your entire response in \`<html>...</html>\` tags. The chat UI renders it in an isolated Shadow DOM with the Noir Terminal Editorial design system pre-loaded.

Available CSS variables: \`--bg\`, \`--surface-1\` through \`--surface-3\`, \`--text\`, \`--text-muted\`, \`--text-dim\`, \`--accent\` (steel blue #5096b3 — primary brand color), \`--accent-hover\`, \`--accent-dim\`, \`--accent-border\`, \`--border\`, \`--border-muted\`, \`--info\`, \`--success\`, \`--warning\`, \`--danger\`. Do NOT use \`--green\` or \`--green-bright\` as accent colors — green is reserved for success/status only.
Fonts: \`var(--font-display)\` (Playfair Display for headlines), \`var(--font-mono)\` (JetBrains Mono for body/code), \`var(--font-body)\` (system sans for long text).
Aesthetic: dark mode only, steel blue accent on dark backgrounds, noir cinematic feel. Use CSS variables — don't hardcode colors. Primary accent is \`--accent\` (steel blue), not green.

For notifications: use \`notify_user\` via the Tools API when the user is not looking at the chat.
For simple text: use markdown.

# Tool Call Strategy

You're encouraged to make multiple tool calls in parallel when possible to speed up the workflow.
`;
