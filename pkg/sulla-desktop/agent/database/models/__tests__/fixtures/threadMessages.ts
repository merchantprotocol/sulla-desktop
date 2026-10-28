// SPDX-License-Identifier: GPL-2.0-or-later
// Realistic UI transcript messages — one of EVERY kind in pages/chat/models/Message.ts —
// plus graph-format messages (PlaybookController sub-agent transcripts).

const T0 = 1_760_000_000_000;

export function uiMessages(): any[] {
  return [
    { id: 'm01', kind: 'user', createdAt: T0, turnId: 'turn1', text: 'Grep the repo for GuestBridge', attachments: [{ id: 'a1', name: 'log.txt', size: '48 KB', kind: 'log' }] },
    { id: 'm02', kind: 'thinking', createdAt: T0 + 1, turnId: 'turn1', thoughts: ['Looking for files', 'Found two'], startedAt: T0 + 1, completed: true, completedAt: T0 + 900, summary: 'Searched' },
    { id: 'm03', kind: 'tool', createdAt: T0 + 2, turnId: 'turn1', tool: 'Grep', desc: 'Search GuestBridge', status: 'ok', meta: '8 hits · 120ms', input: '{"pattern":"GuestBridge"}', output: 'a.ts:1\nb.ts:2', outputFormat: 'text' },
    { id: 'm04', kind: 'tool', createdAt: T0 + 3, turnId: 'turn1', tool: 'Bash', desc: 'Run tests', status: 'error', error: 'exit 1', input: 'npm test' },
    { id: 'm05', kind: 'tool_approval', createdAt: T0 + 4, turnId: 'turn1', reason: 'Delete tmp dir', command: 'rm -rf /tmp/x', decision: 'approved', approvalId: 'ap1', origin: { kind: 'tool', name: 'Bash' } },
    { id: 'm06', kind: 'tool_question', createdAt: T0 + 5, questions: [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'pg', description: 'Postgres' }, { label: 'redis' }] }], status: 'answered', questionId: 'q1', answers: [{ question: 'Which DB?', selected: ['pg'] }] },
    { id: 'm07', kind: 'patch', createdAt: T0 + 6, path: 'pkg/a.ts', stat: { added: 1, removed: 1 }, hunks: [{ lines: [{ n: 1, text: 'a', op: 'remove' }, { n: 1, text: 'b', op: 'add' }] }], state: 'applied', revertMeta: { op: 'edit', path: 'pkg/a.ts', oldString: 'a', newString: 'b' } },
    { id: 'm08', kind: 'channel', createdAt: T0 + 7, agent: 'Heartbeat', channel: 'heartbeat', text: '<b>ping</b> from heartbeat' },
    { id: 'm09', kind: 'subagent', createdAt: T0 + 8, name: 'code-researcher', desc: 'Reading files', status: 'done', steps: [{ tag: 'read', text: 'a.ts' }] },
    { id: 'm10', kind: 'subagent_exchange', createdAt: T0 + 9, direction: 'to_agent', agentId: 'opus-worker', label: 'Brief', summary: 'Do X', detail: 'Long detail', status: 'done', jobId: 'j1', taskIndex: 0, conversationId: 'c1', native: true },
    { id: 'm11', kind: 'citation', createdAt: T0 + 10, sources: [{ num: 1, title: 'Electron', origin: 'electronjs.org', url: 'https://electronjs.org' }] },
    { id: 'm12', kind: 'memory', createdAt: T0 + 11, memId: 'w9oK', action: 'saved', summary: 'Likes dark mode' },
    { id: 'm13', kind: 'proactive', createdAt: T0 + 12, headline: 'Heads up', body: 'Your build is **red**' },
    { id: 'm14', kind: 'heartbeat', createdAt: T0 + 13, text: 'Waking in 30m', intervalMinutes: 30 },
    { id: 'm15', kind: 'tts', createdAt: T0 + 14, text: 'Speaking now', refId: 'm17', endsAt: T0 + 5000 },
    { id: 'm16', kind: 'interim', createdAt: T0 + 15, text: 'hey sul', startedAt: T0 + 15 },
    { id: 'm17', kind: 'sulla', createdAt: T0 + 16, turnId: 'turn1', text: 'Found **2** files. Unicode ✅ "quotes" \\ backslash', model: 'opus-4.7', tokens: 321, pinned: true },
    { id: 'm18', kind: 'error', createdAt: T0 + 17, text: 'Provider timed out', detail: 'ETIMEDOUT', action: { label: 'Retry', kind: 'retry' } },
    { id: 'm19', kind: 'html', createdAt: T0 + 18, html: '<div class="x">rich</div>', artifactId: 'art1' },
    { id: 'm20', kind: 'streaming', createdAt: T0 + 19, turnId: 'turn2', text: 'Partial answ', startedAt: T0 + 19 },
  ];
}

export function graphMessages(): any[] {
  return [
    { role: 'system', content: 'You are a worker' },
    { role: 'user', content: 'Do the thing' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec', arguments: '{"cmd":"ls"}' } }] },
    { role: 'tool', content: 'file1\nfile2', tool_call_id: 'call_1', name: 'exec' },
    { id: 'gm5', role: 'assistant', content: [{ type: 'text', text: 'Done.' }, { type: 'text', text: 'Two files.' }] },
  ];
}

export function uiState(threadId: string, messages: any[] = uiMessages()): any {
  return {
    thread:    { id: threadId, title: 'GuestBridge hunt', messages, model: 'opus-4.7', createdAt: T0 },
    runState:  'idle',
    queue:     [{ id: 'q1', text: 'next' }],
    staged:    null,
    artifacts: { list: [{ id: 'art1', kind: 'html' }] },
    heartbeat: { enabled: true, intervalMinutes: 30 },
  };
}
