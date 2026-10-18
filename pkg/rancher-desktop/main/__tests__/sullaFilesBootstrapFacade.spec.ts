/** @jest-environment node */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const electron = { app: { getAppPath: jest.fn() } };

jest.unstable_mockModule('electron', () => ({ __esModule: true, default: electron, ...electron }));

const { SullaFilesBootstrapFacade } = await import('../sullaFilesBootstrapFacade');

describe('SullaFilesBootstrapFacade retry lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('shares in-flight work, backs failures off, and resets the delay after success', async() => {
    let resolveFirst!: (value: { ok: false; code: string }) => void;
    const first = new Promise<{ ok: false; code: string }>((resolve) => { resolveFirst = resolve });
    const spawn = jest.spyOn(SullaFilesBootstrapFacade.prototype as any, 'spawn')
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ ok: true, state: 'unlocked', legacyImport: 'clear', recovered: false })
      .mockResolvedValueOnce({ ok: false, code: 'FILES_SYNTHETIC_FAILURE' })
      .mockResolvedValueOnce({ ok: true, state: 'unlocked', legacyImport: 'clear', recovered: false });
    const facade = new SullaFilesBootstrapFacade();

    const one = facade.initialize();
    const two = facade.initialize();

    expect(spawn).toHaveBeenCalledTimes(1);
    resolveFirst({ ok: false, code: 'FILES_SYNTHETIC_FAILURE' });
    await expect(Promise.all([one, two])).resolves.toEqual([
      { ok: false, code: 'FILES_SYNTHETIC_FAILURE' },
      { ok: false, code: 'FILES_SYNTHETIC_FAILURE' },
    ]);

    jest.advanceTimersByTime(4_999);
    await expect(facade.initialize()).resolves.toEqual({ ok: false, code: 'FILES_SYNTHETIC_FAILURE' });
    expect(spawn).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    await expect(facade.initialize()).resolves.toMatchObject({ ok: true });
    await expect(facade.initialize()).resolves.toEqual({ ok: false, code: 'FILES_SYNTHETIC_FAILURE' });
    expect(spawn).toHaveBeenCalledTimes(3);

    jest.advanceTimersByTime(4_999);
    await expect(facade.initialize()).resolves.toEqual({ ok: false, code: 'FILES_SYNTHETIC_FAILURE' });
    expect(spawn).toHaveBeenCalledTimes(3);

    jest.advanceTimersByTime(1);
    await expect(facade.initialize()).resolves.toMatchObject({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(4);
  });
});
