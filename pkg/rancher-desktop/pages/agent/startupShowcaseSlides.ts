/**
 * Copy for the feature slideshow on the startup screen.
 *
 * How to add a slide: append an object to SHOWCASE_SLIDES with a unique `id`,
 * a short `eyebrow`, a `title` that leads with the benefit, a `body` of one or
 * two plain sentences, an `art` key from ShowcaseArt (or add a new icon in
 * StartupShowcase.vue), and `sources` naming the doc or code that backs every
 * claim. Rules: only say what the app really does today, no pricing, no made-up
 * numbers, no hype words (see resources/sulla-docs/agent-patterns/writing-voice.md).
 * Counts come from code at runtime (see `body` as a function), never typed in.
 * Tests in __tests__/startupShowcaseSlides.test.ts check the shape.
 */

export type ShowcaseArt =
  | 'agents' | 'routines' | 'vault' | 'files' | 'models' | 'integrations'
  | 'projects' | 'heartbeat' | 'secretary' | 'capture' | 'phone' | 'sandbox';

export interface ShowcaseContext {
  /** Built-in integration count from agent/integrations/native, or null before it loads. */
  integrationCount: number | null;
}

export interface ShowcaseSlide {
  id:      string;
  eyebrow: string;
  title:   string | ((ctx: ShowcaseContext) => string);
  body:    string;
  art:     ShowcaseArt;
  /** Where each claim was checked. For maintainers; not shown. */
  sources: string[];
}

/** Model and agent providers named on the "models" slide; a test checks each exists in the catalog. */
export const SHOWCASE_MODEL_NAMES = ['Claude Code', 'OpenAI Codex', 'OpenCode', 'Grok', 'Google Gemini', 'Ollama'];

export const SHOWCASE_SLIDES: ShowcaseSlide[] = [
  {
    id:      'agents',
    eyebrow: 'Agents',
    title:   'Ask for the result, not the steps.',
    body:    'Sulla\'s agents work with real tools: a browser, GitHub, your calendar, Slack and a shell. They do the job and tell you what changed.',
    art:     'agents',
    sources: ['resources/sulla-docs/tools/inventory.md', 'resources/sulla-docs/tools/browser.md', 'resources/sulla-docs/tools/github.md'],
  },
  {
    id:      'routines',
    eyebrow: 'Routines',
    title:   'Set it up once. It runs on schedule.',
    body:    'Turn a task you repeat into a routine and give it a schedule. Sulla runs it in the background, no reminder needed.',
    art:     'routines',
    sources: ['resources/sulla-docs/workflows/authoring.md', 'pkg/rancher-desktop/sulla.ts (workflow-scheduler)'],
  },
  {
    id:      'vault',
    eyebrow: 'Password Vault',
    title:   'Agents can sign in without seeing your password.',
    body:    'The vault fills a login into the browser for an agent, and the password never comes back to it. You pick how much each login allows.',
    art:     'vault',
    sources: ['resources/sulla-docs/tools/vault.md'],
  },
  {
    id:      'files',
    eyebrow: 'Files',
    title:   'Every save keeps the one before it.',
    body:    'You and your agents share Files. Each change is a new version, so an older copy is one restore away.',
    art:     'files',
    sources: ['resources/sulla-docs/tools/inventory.md (files/history, files/restore)'],
  },
  {
    id:      'models',
    eyebrow: 'Models',
    title:   'Pick the model for the job.',
    body:    `${ SHOWCASE_MODEL_NAMES.slice(0, -1).join(', ') } or ${ SHOWCASE_MODEL_NAMES[SHOWCASE_MODEL_NAMES.length - 1] }. Set a primary and a backup in settings.`,
    art:     'models',
    sources: ['pkg/rancher-desktop/agent/integrations/native/ai_infrastructure.ts', 'pkg/rancher-desktop/pages/LanguageModelSettings.vue'],
  },
  {
    id:      'integrations',
    eyebrow: 'Integrations',
    title:   ctx => ctx.integrationCount ? `${ ctx.integrationCount } integrations, built in.` : 'Integrations, built in.',
    body:    'CRMs, ad platforms, databases, Slack, GitHub. Connect an account once and agents call it through the vault, so the key stays out of the chat.',
    art:     'integrations',
    sources: ['pkg/rancher-desktop/agent/integrations/native/index.ts', 'resources/sulla-docs/tools/vault.md (proxy pattern)'],
  },
  {
    id:      'projects',
    eyebrow: 'Projects',
    title:   'One board for you and your agents.',
    body:    'Projects holds the plan as epics and tasks. Agents move their own cards and leave comments, and you see each change on the board.',
    art:     'projects',
    sources: ['resources/sulla-docs/tools/project.md'],
  },
  {
    id:      'heartbeat',
    eyebrow: 'Heartbeat',
    title:   'Work keeps moving while you\'re away.',
    body:    'Turn on the Heartbeat and an agent checks in on your goals on a schedule, every 15 minutes by default, and acts without waiting to be asked.',
    art:     'heartbeat',
    sources: ['resources/sulla-docs/environment/heartbeat.md'],
  },
  {
    id:      'secretary',
    eyebrow: 'Secretary Mode',
    title:   'Meeting notes you didn\'t have to take.',
    body:    'Press Cmd+Shift+S. Sulla transcribes both sides of the call and pulls out action items and decisions. Notes save when you hit End.',
    art:     'secretary',
    sources: ['resources/sulla-docs/desktop/secretary-mode.md'],
  },
  {
    id:      'capture',
    eyebrow: 'Capture Studio',
    title:   'Screen, camera and mic on separate tracks.',
    body:    'Capture Studio records each source to its own file, so editing later is easy. A teleprompter follows along as you talk.',
    art:     'capture',
    sources: ['resources/sulla-docs/desktop/capture-studio.md'],
  },
  {
    id:      'phone',
    eyebrow: 'Sulla Mobile',
    title:   'Talk to your desktop from your phone.',
    body:    'Pair Sulla Mobile, hold the Sulla button and speak. Your desktop does the work and streams the answer back.',
    art:     'phone',
    sources: ['resources/sulla-docs/mobile/overview.md'],
  },
  {
    id:      'sandbox',
    eyebrow: 'Sandbox',
    title:   'Agents work in their own Linux VM.',
    body:    'Your home folder isn\'t mounted inside it. Agents see the files you share through Files, and reaching the Mac itself is a setting you turn on.',
    art:     'sandbox',
    sources: ['resources/sulla-docs/environment/architecture.md (Lima VM)', 'pkg/rancher-desktop/sulla.ts (host-access-sync)'],
  },
];

export function slideTitle(slide: ShowcaseSlide, ctx: ShowcaseContext): string {
  return typeof slide.title === 'function' ? slide.title(ctx) : slide.title;
}

/** Loads the integration count lazily so the catalog never weighs on first paint. */
export async function loadIntegrationCount(): Promise<number | null> {
  try {
    const { nativeIntegrations } = await import(/* webpackChunkName: "integration-catalog" */ '@pkg/agent/integrations/native');

    return Object.values(nativeIntegrations).filter(i => !i.comingSoon).length;
  } catch {
    return null;
  }
}
