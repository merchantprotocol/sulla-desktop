import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockGet: any = jest.fn();

jest.unstable_mockModule('../../../integrations', () => ({
  registry: {
    get: mockGet,
  },
}));

async function loadSlackSearchUsersTool() {
  return import('../slack_search_users');
}

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('slack_search_users tool', () => {
  afterEach(() => {
    mockGet.mockReset();
  });

  it('returns success with matching users', async() => {
    const { SlackSearchUsersWorker, slackSearchUsersRegistration } = await loadSlackSearchUsersTool();

    mockGet.mockResolvedValueOnce({
      searchUsers: jest.fn(async() => ([
        { id: 'U1', name: 'jdoe', real_name: 'John Doe' },
      ])),
    });

    const worker = configureWorker(new SlackSearchUsersWorker(), slackSearchUsersRegistration);
    const result = await worker.invoke({ query: 'john' });

    expect(result.success).toBe(true);
    expect(result.result).toContain('Found 1 Slack user(s)');
    expect(result.result).toContain('U1');
  });

  it('returns failure when no users match', async() => {
    const { SlackSearchUsersWorker, slackSearchUsersRegistration } = await loadSlackSearchUsersTool();

    mockGet.mockResolvedValueOnce({
      searchUsers: jest.fn(async() => []),
    });

    const worker = configureWorker(new SlackSearchUsersWorker(), slackSearchUsersRegistration);
    const result = await worker.invoke({ query: 'nobody' });

    expect(result.success).toBe(false);
    expect(result.result).toContain('No Slack users found');
  });
});
