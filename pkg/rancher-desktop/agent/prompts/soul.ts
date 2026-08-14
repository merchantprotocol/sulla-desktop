// Single-source soul: the canonical identity lives in sections/soul.ts.
// This re-export feeds the settings UI its default soul text (the user's
// soulPrompt setting overrides it at runtime). Keeping one source prevents
// the observer-era drift where two soul copies disagreed.
export { SOUL_CONTENT as soulPrompt } from './sections/soul';
