import http from 'node:http';

let job = 0;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.includes('/spawn_agent/')) {
      response.end(JSON.stringify({ success: true, result: { jobId: `verify-job-${ ++job }` } }));
      return;
    }
    if (request.url?.includes('/check_agent_jobs/')) {
      response.end(JSON.stringify({ success: true, result: { jobId: body.jobId, status: 'completed', output: 'true' } }));
      return;
    }
    response.end(JSON.stringify({ success: true, result: { echoed: body, source: 'verification-tool-api' } }));
  });
});
server.listen(3000, '0.0.0.0', () => console.log('verification tool API listening on 3000'));
