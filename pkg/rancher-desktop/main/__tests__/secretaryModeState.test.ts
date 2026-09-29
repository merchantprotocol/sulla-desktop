import path from 'path';

import { resolveMeetingNotesPath } from '@pkg/main/secretaryModeState';

jest.mock('electron', () => ({ ipcMain: { on: jest.fn(), handle: jest.fn() }, shell: { showItemInFolder: jest.fn() } }));
jest.mock('@pkg/agent/utils/sullaPaths', () => ({ resolveSullaHomeDir: () => '/home/user/sulla' }));

const MEETINGS = path.join('/home/user/sulla', 'meetings');

describe('resolveMeetingNotesPath', () => {
  it('puts new notes in the meetings dir', () => {
    expect(resolveMeetingNotesPath('2026-09-28-2105-meeting.md')).toBe(path.join(MEETINGS, '2026-09-28-2105-meeting.md'));
  });

  it('reuses the path from an earlier save of the same session', () => {
    const existing = path.join(MEETINGS, '2026-09-28-2105-meeting.md');

    expect(resolveMeetingNotesPath('other.md', existing)).toBe(existing);
  });

  it('never writes outside the meetings dir', () => {
    expect(resolveMeetingNotesPath('../../.ssh/authorized_keys')).toBe(path.join(MEETINGS, 'authorized_keys.md'));
    expect(resolveMeetingNotesPath('notes.md', '/etc/passwd')).toBe(path.join(MEETINGS, 'notes.md'));
    expect(resolveMeetingNotesPath('notes.md', path.join(MEETINGS, '..', 'identity.md'))).toBe(path.join(MEETINGS, 'notes.md'));
  });
});
