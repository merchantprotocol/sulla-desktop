import { ref, computed, onMounted, watch } from 'vue';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

export type ThemeName = 'default-light' | 'default-dark' | 'ocean-light' | 'ocean-dark' | 'nord-light' | 'nord-dark' | 'protocol-dark';

export type ThemeScheme = 'default' | 'ocean' | 'nord' | 'protocol';

export interface ThemeOption {
  id: ThemeName;
  scheme: ThemeScheme;
  mode: 'light' | 'dark';
  label: string;
  isDark: boolean;
}

export interface ThemeGroup {
  scheme: ThemeScheme;
  label: string;
  themes: ThemeOption[];
}

export const availableThemes: ThemeOption[] = [
  { id: 'default-light', scheme: 'default', mode: 'light', label: 'Default Light', isDark: false },
  { id: 'default-dark', scheme: 'default', mode: 'dark', label: 'Default Dark', isDark: true },
  { id: 'ocean-light', scheme: 'ocean', mode: 'light', label: 'Ocean Light', isDark: false },
  { id: 'ocean-dark', scheme: 'ocean', mode: 'dark', label: 'Ocean Dark', isDark: true },
  { id: 'nord-light', scheme: 'nord', mode: 'light', label: 'Nord Light', isDark: false },
  { id: 'nord-dark', scheme: 'nord', mode: 'dark', label: 'Nord Dark', isDark: true },
  { id: 'protocol-dark', scheme: 'protocol', mode: 'dark', label: 'Protocol Dark', isDark: true },
];

export const themeGroups: ThemeGroup[] = [
  { scheme: 'default', label: 'Default', themes: availableThemes.filter(t => t.scheme === 'default') },
  { scheme: 'ocean', label: 'Ocean', themes: availableThemes.filter(t => t.scheme === 'ocean') },
  { scheme: 'nord', label: 'Nord', themes: availableThemes.filter(t => t.scheme === 'nord') },
  { scheme: 'protocol', label: 'Protocol', themes: availableThemes.filter(t => t.scheme === 'protocol') },
];

const validThemeIds = new Set<string>(availableThemes.map(t => t.id));

/** Map legacy theme names to new IDs for backward compatibility. */
const legacyThemeMap: Record<string, ThemeName> = {
  light:  'default-light',
  dark:   'default-dark',
  ocean:    'ocean-dark',
  nord:     'nord-dark',
  protocol: 'protocol-dark',
};

function isValidTheme(value: unknown): value is ThemeName {
  return typeof value === 'string' && validThemeIds.has(value);
}

function migrateLegacyTheme(value: unknown): ThemeName | null {
  if (typeof value === 'string' && value in legacyThemeMap) {
    return legacyThemeMap[value];
  }

  return null;
}

const THEME_SETTING_KEY = 'theme';
const THEME_STORAGE_KEY = 'agentTheme';

// Shared reactive state across all composable instances in the same window
const currentTheme = ref<ThemeName>('default-light');
let initialized = false;

function applyThemeClass(theme: ThemeName): void {
  const root = document.documentElement;
  // Remove all theme classes
  availableThemes.forEach(t => root.classList.remove(`theme-${t.id}`));
  // Add current theme class
  root.classList.add(`theme-${theme}`);
  // Toggle Tailwind dark class for backward compatibility
  const themeInfo = availableThemes.find(t => t.id === theme);
  if (themeInfo?.isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

async function loadThemeFromSettings(): Promise<ThemeName> {
  try {
    const saved = await SullaSettingsModel.get(THEME_SETTING_KEY, null);
    if (isValidTheme(saved)) {
      return saved;
    }
    const migrated = migrateLegacyTheme(saved);
    if (migrated) {
      return migrated;
    }
  } catch {
    // SullaSettingsModel not ready yet — fall through to localStorage
  }

  // Fallback: check localStorage (legacy support)
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (isValidTheme(stored)) {
    return stored;
  }
  const migratedStored = migrateLegacyTheme(stored);
  if (migratedStored) {
    return migratedStored;
  }

  // Final fallback: OS preference
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'default-dark' : 'default-light';
}

async function persistTheme(theme: ThemeName): Promise<void> {
  // Always write localStorage for immediate cross-window sync
  localStorage.setItem(THEME_STORAGE_KEY, theme);

  try {
    await SullaSettingsModel.set(THEME_SETTING_KEY, theme, 'string');
  } catch {
    // Settings backend not ready — localStorage is sufficient for now
  }
}

export function useTheme() {
  const isDark = computed(() => {
    const themeInfo = availableThemes.find(t => t.id === currentTheme.value);
    return themeInfo?.isDark ?? false;
  });

  const currentScheme = computed<ThemeScheme>(() => {
    const themeInfo = availableThemes.find(t => t.id === currentTheme.value);
    return themeInfo?.scheme ?? 'default';
  });

  function setTheme(theme: ThemeName): void {
    currentTheme.value = theme;
    persistTheme(theme);
  }

  /** Switch scheme, preserving the current light/dark mode when possible. */
  function setScheme(scheme: ThemeScheme): void {
    const current = availableThemes.find(t => t.id === currentTheme.value);
    const preferredMode = current?.mode ?? 'dark';
    // Try to find the variant matching the current mode, fall back to any variant
    const match = availableThemes.find(t => t.scheme === scheme && t.mode === preferredMode)
      ?? availableThemes.find(t => t.scheme === scheme);
    if (match) {
      setTheme(match.id);
    }
  }

  /** Toggle between light and dark mode within the current scheme. */
  function toggleTheme(): void {
    const current = availableThemes.find(t => t.id === currentTheme.value);
    if (!current) {
      setTheme('default-light');
      return;
    }
    const newMode = current.mode === 'dark' ? 'light' : 'dark';
    const target = availableThemes.find(t => t.scheme === current.scheme && t.mode === newMode);
    // If the opposite mode doesn't exist for this scheme (e.g. Protocol has no light), stay put
    if (target) {
      setTheme(target.id);
    }
  }

  // Apply theme class to document.documentElement whenever theme changes
  watch(currentTheme, (theme) => {
    applyThemeClass(theme);
  });

  onMounted(async () => {
    if (!initialized) {
      initialized = true;
      currentTheme.value = await loadThemeFromSettings();
    }
    // Apply on mount in case the watch didn't fire (value unchanged)
    applyThemeClass(currentTheme.value);
  });

  // Listen for cross-window localStorage changes
  if (typeof window !== 'undefined' && !initialized) {
    window.addEventListener('storage', (e) => {
      if (e.key === THEME_STORAGE_KEY) {
        if (isValidTheme(e.newValue)) {
          currentTheme.value = e.newValue;
        } else {
          const migrated = migrateLegacyTheme(e.newValue);
          if (migrated) {
            currentTheme.value = migrated;
          }
        }
      }
    });
  }

  return {
    currentTheme,
    currentScheme,
    isDark,
    setTheme,
    setScheme,
    toggleTheme,
    availableThemes,
    themeGroups,
  };
}
