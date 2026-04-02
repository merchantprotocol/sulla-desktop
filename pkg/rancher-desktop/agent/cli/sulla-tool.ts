#!/usr/bin/env node

import http from 'node:http';

const SOCKET_PATH = '/tmp/sulla-tools.sock';

function printHelp(): void {
  const help = `
sulla-tool — Fast CLI for invoking Sulla Desktop tools

USAGE
  sulla-tool <slug>/<endpoint> [json_body]     Call a tool
  sulla-tool list [search]                      Discover available tools
  sulla-tool --help                             Show this help

FLAGS
  --accountId=<id>, -a <id>    Account ID for the tool call (default: "internal")
  --timeout=<ms>,   -t <ms>    Request timeout in milliseconds (default: 30000)
  --help,           -h         Show this help message
  --version,        -v         Print version

EXAMPLES
  # Internal tools (accountId defaults to "internal")
  sulla-tool github/create_issue '{"title":"Fix login bug","body":"Details here"}'
  sulla-tool exec '{"command":"ls -la"}'
  sulla-tool vault_list '{}'
  sulla-tool playwright/browser_tab '{"action":"upsert","url":"https://example.com"}'

  # Integration tools (specify accountId)
  sulla-tool gmail/send_email --accountId=jonathon_gmail '{"to":"user@example.com","subject":"Hello"}'
  sulla-tool slack/post_message -a workspace_slack '{"channel":"general","text":"Hi from CLI"}'

  # MCP tools
  sulla-tool mcp/search_docs --accountId=notion_workspace '{"query":"authentication"}'

  # Discovery
  sulla-tool list                    # List all available tools
  sulla-tool list vault              # Search tools by keyword
  sulla-tool list playwright         # Find browser tools

TOOL PATH FORMAT
  <slug>/<endpoint>    Maps to the Tools API route:
                       POST /v1/tools/{accountId}/{slug}/{endpoint}/call

                       For single-name tools without a category prefix, just use
                       the tool name directly:  sulla-tool vault_list '{}'

HOW IT WORKS
  sulla-tool connects to the running Sulla Desktop app over a Unix Domain
  Socket at ${ SOCKET_PATH }. The tool executes inside the Electron main
  process with full access to IPC, vault, browser tabs, and all services.

  This is significantly faster than curl over TCP because it skips DNS
  resolution, TCP handshake, and process spawning overhead.

REQUIREMENTS
  Sulla Desktop must be running. If you see a connection error, make sure
  the app is open.

OUTPUT
  JSON to stdout:  {"success": true, "result": ...}
  Errors to stderr when the connection fails.

EXIT CODES
  0    Tool executed successfully
  1    Tool executed but returned an error
  2    Invalid arguments or usage error
  3    Infrastructure error (app not running, socket unavailable)
`.trimStart();

  process.stdout.write(help);
}

function printVersion(): void {
  process.stdout.write('sulla-tool 1.0.0\n');
}

interface ParsedArgs {
  command: 'call' | 'list' | 'help' | 'version';
  slug?: string;
  endpoint?: string;
  accountId: string;
  body?: string;
  search?: string;
  timeout: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return { command: 'help', accountId: 'internal', timeout: 30000 };
  }

  if (args.includes('--version') || args.includes('-v')) {
    return { command: 'version', accountId: 'internal', timeout: 30000 };
  }

  let accountId = 'internal';
  let timeout = 30000;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--accountId=')) {
      accountId = arg.split('=', 2)[1];
    } else if (arg === '--accountId' || arg === '-a') {
      accountId = args[++i] || 'internal';
    } else if (arg.startsWith('--timeout=')) {
      timeout = parseInt(arg.split('=', 2)[1], 10) || 30000;
    } else if (arg === '--timeout' || arg === '-t') {
      timeout = parseInt(args[++i], 10) || 30000;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional[0] === 'list') {
    return {
      command:   'list',
      accountId,
      timeout,
      search:    positional.slice(1).join(' ') || undefined,
    };
  }

  const toolPath = positional[0];
  if (!toolPath) {
    return { command: 'help', accountId, timeout };
  }

  const slashIdx = toolPath.indexOf('/');
  let slug: string;
  let endpoint: string;

  if (slashIdx === -1) {
    slug = 'internal';
    endpoint = toolPath;
    accountId = 'internal';
  } else {
    slug = toolPath.substring(0, slashIdx);
    endpoint = toolPath.substring(slashIdx + 1);
  }

  const body = positional[1] || undefined;

  return { command: 'call', slug, endpoint, accountId, body, timeout };
}

function httpRequest(options: http.RequestOptions, body?: string): Promise<{ statusCode: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 500,
          data:       Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(options.timeout as number || 30000, () => {
      req.destroy(new Error('Request timed out'));
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function callTool(parsed: ParsedArgs): Promise<void> {
  const { slug, endpoint, accountId, body, timeout } = parsed;
  const urlPath = `/v1/tools/${ accountId }/${ slug }/${ endpoint }/call`;

  let requestBody: string;
  if (body) {
    try {
      JSON.parse(body);
      requestBody = body;
    } catch {
      process.stderr.write(`Error: Invalid JSON body: ${ body }\n`);
      process.exit(2);
    }
  } else {
    requestBody = '{}';
  }

  try {
    const res = await httpRequest({
      socketPath: SOCKET_PATH,
      path:       urlPath,
      method:     'POST',
      headers:    { 'Content-Type': 'application/json' },
      timeout,
    }, requestBody);

    process.stdout.write(res.data);
    process.stdout.write('\n');

    try {
      const json = JSON.parse(res.data);
      process.exit(json.success ? 0 : 1);
    } catch {
      process.exit(res.statusCode >= 400 ? 1 : 0);
    }
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      process.stderr.write('Error: Cannot connect to Sulla Desktop. Is the app running?\n');
      process.stderr.write(`  Socket: ${ SOCKET_PATH }\n`);
      process.exit(3);
    }
    process.stderr.write(`Error: ${ err.message }\n`);
    process.exit(3);
  }
}

async function listTools(parsed: ParsedArgs): Promise<void> {
  const { search, timeout } = parsed;
  const urlPath = search
    ? `/v1/tools/list?search=${ encodeURIComponent(search) }`
    : '/v1/tools/list';

  try {
    const res = await httpRequest({
      socketPath: SOCKET_PATH,
      path:       urlPath,
      method:     'GET',
      timeout,
    });

    process.stdout.write(res.data);
    process.stdout.write('\n');
    process.exit(res.statusCode >= 400 ? 1 : 0);
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      process.stderr.write('Error: Cannot connect to Sulla Desktop. Is the app running?\n');
      process.stderr.write(`  Socket: ${ SOCKET_PATH }\n`);
      process.exit(3);
    }
    process.stderr.write(`Error: ${ err.message }\n`);
    process.exit(3);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  switch (parsed.command) {
  case 'help':
    printHelp();
    process.exit(0);
    break;
  case 'version':
    printVersion();
    process.exit(0);
    break;
  case 'list':
    await listTools(parsed);
    break;
  case 'call':
    await callTool(parsed);
    break;
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${ err.message }\n`);
  process.exit(3);
});
