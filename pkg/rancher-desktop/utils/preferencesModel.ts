/**
 * Plain logic behind the Preferences window: which sections exist, how old
 * window and tab names map onto them, and how a proposed settings change is
 * applied. Kept free of Vue and IPC so it can be tested on its own.
 */

export type PreferencesSectionId =
  'general' | 'appearance' |
  'models' | 'personality' | 'heartbeat' | 'voice' | 'workflows' |
  'account' | 'files' | 'privacy' |
  'docker' | 'kubernetes' |
  'advanced';

export interface PreferencesNavItem {
  id:    PreferencesSectionId;
  icon:  string;
  label: string;
}

export interface PreferencesNavGroup {
  /** Group heading; `null` draws a separator instead (none for the first group). */
  title: string | null;
  items: PreferencesNavItem[];
}

export const PREFERENCES_NAV: PreferencesNavGroup[] = [
  {
    title: null,
    items: [
      { id: 'general', icon: 'app', label: 'General' },
      { id: 'appearance', icon: 'paint', label: 'Appearance' },
    ],
  },
  {
    title: 'Sulla',
    items: [
      { id: 'models', icon: 'spark', label: 'AI models' },
      { id: 'personality', icon: 'face', label: 'Personality' },
      { id: 'heartbeat', icon: 'heart', label: 'Heartbeat' },
      { id: 'voice', icon: 'mic', label: 'Voice & audio' },
      { id: 'workflows', icon: 'flow', label: 'Workflows' },
    ],
  },
  {
    title: 'You',
    items: [
      { id: 'account', icon: 'user', label: 'Account & Cloud' },
      { id: 'files', icon: 'folder', label: 'Files & backups' },
      { id: 'privacy', icon: 'shield', label: 'Privacy & security' },
    ],
  },
  {
    title: 'Containers',
    items: [
      { id: 'docker', icon: 'box', label: 'Docker' },
      { id: 'kubernetes', icon: 'helm', label: 'Kubernetes' },
    ],
  },
  {
    title: null,
    items: [{ id: 'advanced', icon: 'wrench', label: 'Advanced' }],
  },
];

export const PREFERENCES_SECTION_IDS: PreferencesSectionId[] = PREFERENCES_NAV
  .flatMap(group => group.items.map(item => item.id));

/**
 * Names the old windows used. Shortcuts, menus and other windows may still
 * ask for these, so they keep landing on the section that took them over.
 */
const LEGACY_SECTION_NAMES: Record<string, PreferencesSectionId> = {
  application:          'general',
  'virtual machine':    'docker',
  'container engine':   'docker',
  wsl:                  'advanced',
  'language model':     'models',
  'language-model':     'models',
  'system-prompt':      'personality',
  'routine-workers':    'workflows',
  audio:                'voice',
  microphone:           'voice',
  transcription:        'voice',
  tts:                  'voice',
  speaker:              'voice',
  secretary:            'voice',
  'my account':         'account',
  cloud:                'account',
  troubleshooting:      'advanced',
  diagnostics:          'advanced',
};

/** Turn a section id, label or legacy window/tab name into a section id. */
export function resolvePreferencesSection(name?: string | null): PreferencesSectionId | undefined {
  if (!name) {
    return undefined;
  }
  const key = name.trim().toLowerCase();
  const direct = PREFERENCES_SECTION_IDS.find(id => id === key);

  if (direct) {
    return direct;
  }
  const byLabel = PREFERENCES_NAV.flatMap(group => group.items).find(item => item.label.toLowerCase() === key);

  return byLabel?.id ?? LEGACY_SECTION_NAMES[key];
}

/** The section before or after `current`, wrapping around (Cmd+[ and Cmd+]). */
export function stepPreferencesSection(
  current: PreferencesSectionId,
  direction: 'forward' | 'back',
): PreferencesSectionId {
  const ids = PREFERENCES_SECTION_IDS;
  const index = Math.max(0, ids.indexOf(current));
  const offset = direction === 'forward' ? 1 : -1;

  return ids[(index + offset + ids.length) % ids.length];
}

export interface ProposalSeverities {
  reset:   boolean;
  restart: boolean;
  error:   boolean;
}

/**
 * What to do with a proposed change to the engine settings:
 * - `apply`: nothing restarts, so save it right away.
 * - `restart`: Docker restarts; hold it until the user confirms.
 * - `reset`: Kubernetes is wiped; hold it until the user confirms.
 * - `invalid`: the backend rejected the value; don't save.
 */
export type ApplyDecision = 'apply' | 'restart' | 'reset' | 'invalid';

export function decideApply(severities: ProposalSeverities): ApplyDecision {
  if (severities.error) {
    return 'invalid';
  }
  if (severities.reset) {
    return 'reset';
  }

  return severities.restart ? 'restart' : 'apply';
}

const BYTE_UNIT_FACTORS: Record<string, number> = {
  '':  1 / 2 ** 30,
  k:   1 / 2 ** 20,
  m:   1 / 2 ** 10,
  g:   1,
  t:   2 ** 10,
};

/**
 * Parse a Lima disk size such as `100GiB`, `100G` or `1TiB` into gibibytes.
 * Returns undefined for anything that isn't a size.
 */
export function diskSizeToGB(value: string | number | undefined | null): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?\s*$/i.exec(value ?? '');

  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]) * BYTE_UNIT_FACTORS[match[2].toLowerCase()];

  return amount > 0 ? amount : undefined;
}

export function gbToDiskSize(gb: number): string {
  return `${ Math.round(gb) }GiB`;
}

export const DISK_SIZE_CHOICES_GB = [64, 100, 200, 400];

export interface DiskSizeChoice {
  gb:       number;
  label:    string;
  /** The disk can only grow, so sizes below the current one are shown but not selectable. */
  disabled: boolean;
}

export function diskSizeChoices(current: string | undefined): DiskSizeChoice[] {
  const currentGB = diskSizeToGB(current) ?? 100;
  const sizes = Array.from(new Set([...DISK_SIZE_CHOICES_GB, Math.round(currentGB)])).sort((a, b) => a - b);

  return sizes.map(gb => ({ gb, label: `${ gb } GB`, disabled: gb < Math.round(currentGB) }));
}

/** Slider position (0–100) of `value` on a track from `min` to `max`. */
export function rangePercent(value: number, min: number, max: number): number {
  if (max <= min) {
    return 100;
  }

  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

export type VmType = 'vz' | 'qemu';
export type MountKind = 'virtiofs' | 'reverse-sshfs' | '9p';

/** Whether a file-sharing mode works with a VM type (the same rules the settings validator enforces). */
export function mountWorksWith(mount: MountKind, vm: VmType, platform: string): boolean {
  if (platform !== 'darwin') {
    return true;
  }
  if (mount === 'virtiofs') {
    return vm === 'vz';
  }

  return mount === '9p' ? vm === 'qemu' : true;
}

/**
 * The settings to change when switching VM type, including the file-sharing
 * mode and Rosetta when the current ones won't work with the new VM.
 */
export function changesForVmType(
  vm: VmType,
  current: { mount: MountKind, useRosetta: boolean },
  platform: string,
): Record<string, unknown> {
  const changes: Record<string, unknown> = { 'virtualMachine.type': vm };

  if (!mountWorksWith(current.mount, vm, platform)) {
    changes['virtualMachine.mount.type'] = vm === 'vz' ? 'virtiofs' : 'reverse-sshfs';
  }
  if (vm !== 'vz' && current.useRosetta) {
    changes['virtualMachine.useRosetta'] = false;
  }

  return changes;
}
