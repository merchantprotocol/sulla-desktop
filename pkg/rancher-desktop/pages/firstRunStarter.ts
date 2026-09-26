/**
 * Settings key for the starter automation chosen in the first-run wizard.
 *
 * FirstRunFirstAutomation writes the user's first request here; the chat
 * composer reads it once when the main window opens, prefills the draft, and
 * clears the key so it never appears again.
 */
export const FIRST_RUN_STARTER_PROMPT_KEY = 'firstRunStarterPrompt';
