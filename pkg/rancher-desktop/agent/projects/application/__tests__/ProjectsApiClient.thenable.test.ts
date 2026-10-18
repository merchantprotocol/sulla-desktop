import { jest } from '@jest/globals';

jest.unstable_mockModule('@pkg/utils/paths', () => ({ default: { appHome: '/synthetic-projects-client-test' } }));

const { getProjectsApiClient } = await import('../ProjectsApiClient');

describe('ProjectsApiClient proxy', () => {
  test('is not treated as a promise-like RPC client', async() => {
    const client = getProjectsApiClient();
    await expect(Promise.resolve(client)).resolves.toBe(client);
  });
});
