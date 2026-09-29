/**
 * Pure text helpers for TTS playback — no DOM/IPC, so they're unit-testable.
 * Mirrors Sulla Mobile's src/services/voice/voiceText.ts.
 */

/**
 * Split text into synthesis units: sentences, and over-long sentences at
 * clause breaks (then word breaks). The first unit is kept short so audio
 * starts sooner; later units render while earlier ones play.
 */
export function splitForSynthesis(text: string, max = 160, firstMax = 90): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const out: string[] = [];

  for (const sentence of sentences) {
    let rest = sentence.trim();

    while (rest) {
      const limit = out.length === 0 ? firstMax : max;

      if (rest.length <= limit) {
        out.push(rest);
        break;
      }
      const window = rest.slice(0, limit);
      let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' — '));

      if (cut < limit * 0.3) cut = window.lastIndexOf(' ');
      if (cut <= 0) cut = limit - 1;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
  }

  return out.filter(Boolean);
}
