import http from 'node:http';

const identities = {
  'admin-a': {
    subject: 'admin-a', authorityId: '11111111-1111-4111-8111-111111111111',
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['admin'],
  },
  'viewer-a': {
    subject: 'viewer-a', authorityId: '11111111-1111-4111-8111-111111111111',
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['viewer'],
  },
  'editor-a': {
    subject: 'editor-a', authorityId: '11111111-1111-4111-8111-111111111111',
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['editor'],
  },
  'admin-b': {
    subject: 'admin-b', authorityId: '22222222-2222-4222-8222-222222222222',
    organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', roles: ['admin'],
  },
};

http.createServer(async(request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const token = body.token;
  const identity = identities[token];
  if (!identity) {
    response.writeHead(token === 'forbidden' ? 403 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'denied' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    issuer: 'urn:sulla:accounts:test', ...identity, groups: [], audience: body.audience,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  }));
}).listen(3020, '0.0.0.0');
