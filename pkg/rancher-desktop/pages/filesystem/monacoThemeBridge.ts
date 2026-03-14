/**
 * Monaco Theme Bridge
 *
 * Reads the current CSS custom-property values from the DOM and registers
 * a matching Monaco editor theme so that the code editor stays in sync with
 * the rest of the Sulla workbench theme system.
 *
 * Call `applyMonacoTheme(isDark)` whenever the app theme changes.
 */
import * as monaco from 'monaco-editor';

const THEME_NAME = 'sulla-custom';

/** Read a CSS custom property from :root (computed). */
function cssVar(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw || fallback;
}

/**
 * Build and register (or re-register) the `sulla-custom` Monaco theme
 * based on the live CSS variables the current workbench theme exposes.
 */
export function applyMonacoTheme(isDark: boolean): void {
  const base = isDark ? 'vs-dark' : 'vs';

  // -- Read live CSS variables --------------------------------------------------
  const editorBg       = cssVar('--editor-bg',       isDark ? '#1e1e2e' : '#f0f0f0');
  const textPrimary    = cssVar('--text-primary',     isDark ? '#ffffff' : '#0d0d0d');
  const textSecondary  = cssVar('--text-secondary',   isDark ? '#94a3b8' : '#64748b');
  const textMuted      = cssVar('--text-muted',       isDark ? '#cbd5e1' : '#94a3b8');
  const bgSurface      = cssVar('--bg-surface',       isDark ? '#1e293b' : '#f8fafc');
  const bgSurfaceAlt   = cssVar('--bg-surface-alt',   isDark ? '#334155' : '#f1f5f9');
  const borderDefault  = cssVar('--border-default',   isDark ? 'rgba(255,255,255,0.1)' : '#e2e8f0');
  const accentPrimary  = cssVar('--accent-primary',   isDark ? '#38bdf8' : '#0ea5e9');
  const textError      = cssVar('--text-error',       isDark ? '#f87171' : '#dc2626');
  const textWarning    = cssVar('--text-warning',     isDark ? '#fbbf24' : '#d97706');
  const textSuccess    = cssVar('--text-success',     isDark ? '#4ade80' : '#16a34a');
  const textInfo       = cssVar('--text-info',        isDark ? '#38bdf8' : '#0284c7');
  const editorBorder   = cssVar('--editor-border',    isDark ? '#334155' : '#cbd5e1');
  const selectionBg    = cssVar('--terminal-selection-bg', isDark ? 'rgba(59,130,246,0.5)' : 'rgba(59,130,246,0.25)');

  // -- Define the theme ---------------------------------------------------------
  monaco.editor.defineTheme(THEME_NAME, {
    base,
    inherit: true,
    rules: [
      // Let the base theme handle most syntax highlighting.
      // Override only semantic categories we want to lock to our palette.
      { token: 'comment',    foreground: toHex6(textMuted) },
      { token: 'keyword',    foreground: toHex6(accentPrimary) },
      { token: 'string',     foreground: toHex6(textSuccess) },
      { token: 'number',     foreground: toHex6(textWarning) },
      { token: 'type',       foreground: toHex6(textInfo) },
      { token: 'delimiter',  foreground: toHex6(textSecondary) },
      { token: 'invalid',    foreground: toHex6(textError) },
    ],
    colors: {
      // Editor chrome
      'editor.background':                 editorBg,
      'editor.foreground':                 textPrimary,
      'editorLineNumber.foreground':       textMuted,
      'editorLineNumber.activeForeground': textSecondary,
      'editorCursor.foreground':           accentPrimary,

      // Selection
      'editor.selectionBackground':            selectionBg,
      'editor.inactiveSelectionBackground':    selectionBg,

      // Current line highlight
      'editor.lineHighlightBackground':    bgSurfaceAlt,
      'editor.lineHighlightBorder':        '#00000000',

      // Widget / suggest / hover panels
      'editorWidget.background':           bgSurface,
      'editorWidget.border':               editorBorder,
      'editorSuggestWidget.background':    bgSurface,
      'editorSuggestWidget.border':        editorBorder,
      'editorSuggestWidget.selectedBackground': bgSurfaceAlt,
      'editorHoverWidget.background':      bgSurface,
      'editorHoverWidget.border':          editorBorder,

      // Gutter / rulers
      'editorGutter.background':           editorBg,
      'editorRuler.foreground':            borderDefault,

      // Minimap
      'minimap.background':                editorBg,

      // Scrollbar
      'scrollbarSlider.background':        isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
      'scrollbarSlider.hoverBackground':   isDark ? 'rgba(255,255,255,0.2)'  : 'rgba(0,0,0,0.15)',
      'scrollbarSlider.activeBackground':  isDark ? 'rgba(255,255,255,0.3)'  : 'rgba(0,0,0,0.2)',

      // Diff editor
      'diffEditor.insertedTextBackground': isDark ? 'rgba(74,222,128,0.12)' : 'rgba(34,197,94,0.12)',
      'diffEditor.removedTextBackground':  isDark ? 'rgba(248,113,113,0.12)' : 'rgba(220,38,38,0.12)',
    },
  });

  monaco.editor.setTheme(THEME_NAME);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a CSS color value to a 6-digit hex string (without #) that Monaco
 * expects for token `foreground` rules. Falls back gracefully.
 */
function toHex6(cssColor: string): string {
  // Already a hex?
  const hex = cssColor.replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return hex;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }

  // Try parsing via a temp element for rgb/rgba/named colors
  try {
    const el = document.createElement('div');
    el.style.color = cssColor;
    document.body.appendChild(el);
    const computed = getComputedStyle(el).color;
    document.body.removeChild(el);
    const match = computed.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (match) {
      return [match[1], match[2], match[3]]
        .map(n => parseInt(n, 10).toString(16).padStart(2, '0'))
        .join('');
    }
  } catch { /* noop */ }

  return '888888'; // safe fallback
}
