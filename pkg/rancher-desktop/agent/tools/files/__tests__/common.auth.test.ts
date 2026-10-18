/** @jest-environment node */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getServicePassword = jest.fn<() => Promise<string>>();

jest.unstable_mockModule('../../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { getServicePassword },
}));
const { FilesTool } = await import('../common');
const { verifyCapabilityToken } = await import('@pkg/runtime/capabilityToken');
const { sullaFilesCapabilityKey } = await import('@pkg/utils/sullaFilesKey');

class TestFilesTool extends FilesTool {
  name = 'files_auth_test';
  description = 'Exercises Files container authentication';

  protected _validatedCall(): Promise<{ successBoolean: boolean; responseString: string }> {
    return Promise.reject(new Error('Not used by this focused authentication test'));
  }

  request(): Promise<Response> {
    return this.containerRequest('/v1/test', undefined);
  }
}

const originalFetch = global.fetch;
const originalCapabilityKey = process.env.SULLA_FILES_CAPABILITY_SIGNING_KEY;
const originalInternalToken = process.env.SULLA_FILES_INTERNAL_TOKEN;
const originalFilesApiUrl = process.env.SULLA_FILES_API_URL;
const fetchMock = jest.fn<typeof fetch>();

function bearerToken(): string {
  const [, init] = fetchMock.mock.calls.at(-1)!;
  const authorization = new Headers(init?.headers).get('authorization');

  expect(authorization).toMatch(/^Bearer /);

  return authorization!.slice('Bearer '.length);
}

describe('FilesTool container authentication', () => {
  beforeEach(() => {
    delete process.env.SULLA_FILES_CAPABILITY_SIGNING_KEY;
    delete process.env.SULLA_FILES_INTERNAL_TOKEN;
    delete process.env.SULLA_FILES_API_URL;
    getServicePassword.mockReset();
    fetchMock.mockReset()
      .mockResolvedValueOnce(new Response('{"principalId":"desktop-owner"}', { status: 200 }))
      .mockResolvedValue(new Response('{}', { status: 200 }));
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalCapabilityKey === undefined) delete process.env.SULLA_FILES_CAPABILITY_SIGNING_KEY;
    else process.env.SULLA_FILES_CAPABILITY_SIGNING_KEY = originalCapabilityKey;
    if (originalInternalToken === undefined) delete process.env.SULLA_FILES_INTERNAL_TOKEN;
    else process.env.SULLA_FILES_INTERNAL_TOKEN = originalInternalToken;
    if (originalFilesApiUrl === undefined) delete process.env.SULLA_FILES_API_URL;
    else process.env.SULLA_FILES_API_URL = originalFilesApiUrl;
  });

  it('uses the canonical key for a 16-character service password and an explicit override', async() => {
    const servicePassword = '0123456789abcdef';

    getServicePassword.mockResolvedValue(servicePassword);
    await expect(new TestFilesTool().request()).resolves.toBeInstanceOf(Response);
    await expect(verifyCapabilityToken(bearerToken(), sullaFilesCapabilityKey(servicePassword))).resolves.toMatchObject({
      sub:    'desktop-owner',
      scopes: ['files/*'],
    });

    const explicitKey = 'explicit-files-signing-key-32-bytes';

    process.env.SULLA_FILES_CAPABILITY_SIGNING_KEY = explicitKey;
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(new Response('{"principalId":"desktop-owner"}', { status: 200 }))
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(new TestFilesTool().request()).resolves.toBeInstanceOf(Response);
    expect(sullaFilesCapabilityKey(servicePassword)).toBe(explicitKey);
    await expect(verifyCapabilityToken(bearerToken(), explicitKey)).resolves.toMatchObject({ scopes: ['files/*'] });
  });

  it('refuses to send Files authority to a configured non-loopback origin', async() => {
    process.env.SULLA_FILES_API_URL = 'https://files.invalid';

    await expect(new TestFilesTool().request()).rejects.toThrow('trusted local service origin');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getServicePassword).not.toHaveBeenCalled();
  });
});
