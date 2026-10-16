import { validateRelayToolCallUser } from '../relayTunnelClient';

const context = {
  v:          1 as const,
  iss:        'test',
  aud:        'sulla-tools' as const,
  sub:        'user-a',
  scopes:     ['*'],
  iat:        1,
  exp:        2,
  jti:        'jti',
  request_id: 'request',
};

test('rejects a tool context belonging to another user', () => {
  expect(validateRelayToolCallUser(context, 'user-b')).toEqual({
    code:    'FORBIDDEN',
    message: 'Tool call user does not own this Desktop',
  });
});
