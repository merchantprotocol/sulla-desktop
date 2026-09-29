import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const settingsGetMock: any = jest.fn();
const archiveCompletedMock: any = jest.fn();

jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: settingsGetMock, set: jest.fn() },
}));

jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel: { archiveCompletedTasks: archiveCompletedMock },
}));

const { ProjectsAutoArchiveService } = await import('../ProjectsAutoArchiveService');

describe('ProjectsAutoArchiveService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    archiveCompletedMock.mockResolvedValue(['a1', 'b2']);
  });

  it('archives finished tasks older than the default 24h', async() => {
    settingsGetMock.mockImplementation((_key: string, fallback: unknown) => Promise.resolve(fallback));
    const ids = await new ProjectsAutoArchiveService().sweep();
    expect(archiveCompletedMock).toHaveBeenCalledWith(24);
    expect(ids).toEqual(['a1', 'b2']);
  });

  it('honors a configured window', async() => {
    settingsGetMock.mockResolvedValue(72);
    await new ProjectsAutoArchiveService().sweep();
    expect(archiveCompletedMock).toHaveBeenCalledWith(72);
  });

  it('does nothing when disabled with 0', async() => {
    settingsGetMock.mockResolvedValue(0);
    expect(await new ProjectsAutoArchiveService().sweep()).toEqual([]);
    expect(archiveCompletedMock).not.toHaveBeenCalled();
  });
});
