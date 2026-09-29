#!/usr/bin/env node
// Builds the shipped Reflex seed (pkg/rancher-desktop/agent/reflex/seed/reflex-seed.json).
// Run: node scripts/build-reflex-seed.mjs   — then run the Reflex seed test.
//
// Builds the shipped Reflex seed: generic Sulla Desktop actions a brand-new user
// is likely to ask for. No personal data — only built-in views, built-in
// containers, and generic capture/secretary/projects/notify reads.
//
// Design (see reflex benchmark): questions about a feature open that feature's
// view (navigation is harmless and helps the model explain); side-effecting
// actions (secretary, recording) only fire on explicit imperatives.
import fs from 'node:fs';

const out = [];
const add = (tool, params, utterances, positive = true) => {
  for (const u of utterances) out.push({ utterance: u.replace(/\s+/g, ' ').trim(), tool, params, positive });
};
const cross = (frames, objects) => frames.flatMap(f => objects.map(o => f.replace('{x}', o)));

// ── Frames ──────────────────────────────────────────────────────────────────
const OPEN = ['open {x}', 'open up {x}', 'show me {x}', 'show {x}', 'pull up {x}', 'bring up {x}', 'take me to {x}',
  'go to {x}', 'switch to {x}', 'let me see {x}', 'get me {x}', 'i want to see {x}'];
const WHERE = ['where is {x}', 'where are {x}', 'where can i find {x}', 'where do i find {x}', 'how do i get to {x}',
  'how do i open {x}', 'where do i go for {x}'];

// ── Views: question vocabulary → open_tab mode ─────────────────────────────
const VIEWS = {
  vault: {
    objects: ['the vault', 'my vault', 'the password vault', 'my passwords', 'my saved passwords', 'my logins', 'my credentials', 'the password manager', 'my secrets'],
    questions: [
      'where do i put my passwords', 'where do i store passwords', 'where should i save my passwords', 'how do i save a password',
      'how do i add a password', 'how do i add a login', 'how do i store my credentials', 'where do i keep my logins',
      'is there a password manager', 'where do i save an api key', 'where do i store api keys', 'how do i add an api key',
      'where do i keep secrets', 'how do i save my login for a website', 'can you remember my passwords', 'where are passwords stored',
      'how do i add credentials', 'save a new password', 'add a new login', 'store a secret', 'what is the vault', 'how does the vault work',
    ],
  },
  integrations: {
    objects: ['integrations', 'the integrations page', 'my integrations', 'connected apps', 'my connections', 'my connected accounts', 'the app connections'],
    questions: [
      'what apps can you connect to', 'what can you integrate with', 'what integrations are there', 'what integrations do you have',
      'how do i connect an app', 'how do i add an integration', 'how do i connect my accounts', 'how do i link an account',
      'connect an app', 'add an integration', 'link my account', 'what services do you work with', 'what tools can you connect to',
      'how do integrations work', 'what is an integration',
    ],
  },
  routines: {
    objects: ['routines', 'my routines', 'automations', 'my automations', 'workflows', 'my workflows', 'scheduled tasks', 'my schedules', 'recurring tasks'],
    questions: [
      'how do i automate something', 'how can i automate a task', 'how do i create an automation', 'how do i make a routine',
      'how do i schedule a task', 'how do i set up a scheduled task', 'can you run something on a schedule', 'can you do something every day',
      'how do i make something run every morning', 'how do i set up a recurring task', 'can you run this every week', 'how do workflows work',
      'how do i build a workflow', 'what is a routine', 'set up an automation', 'create a workflow', 'automate my morning',
    ],
  },
  history: {
    objects: ['history', 'my history', 'chat history', 'my chat history', 'old chats', 'my old chats', 'past conversations', 'previous chats', 'my conversations'],
    questions: [
      'where did my old chat go', 'where are my old conversations', 'how do i find an old chat', 'how do i find a past conversation',
      'how do i see previous chats', 'where can i see my old chats', 'find my last conversation', 'where is the conversation from yesterday',
      'how do i go back to an earlier chat', 'where did our conversation go',
    ],
  },
  agents: {
    objects: ['agents', 'my agents', 'the agents page', 'my assistants', 'my ai assistants', 'my ai employees'],
    questions: [
      'how do i make an agent', 'how do i create an agent', 'how do i make my own agent', 'can i create a custom agent',
      'how do i build an assistant', 'can i make a custom assistant', 'which agents do i have', 'what agents do i have',
      'how do i add an agent', 'how do agents work', 'what is an agent', 'create a new agent', 'make a new assistant',
    ],
  },
  marketplace: {
    objects: ['the marketplace', 'marketplace', 'the store', 'the skill store', 'the plugin store', 'extensions', 'plugins', 'skills', 'templates'],
    questions: [
      'where can i get more skills', 'where do i get plugins', 'how do i install a plugin', 'how do i install an extension',
      'how do i add a skill', 'how do i get more features', 'is there a plugin store', 'is there an app store', 'where are the templates',
      'browse skills', 'browse plugins', 'browse the marketplace', 'find new skills', 'what skills can i add', 'install a skill',
    ],
  },
  projects: {
    objects: ['projects', 'my projects', 'the projects board', 'the project board', 'the kanban', 'the kanban board', 'the task board', 'my task board', 'project management'],
    questions: [
      'where do i keep track of tasks', 'where do i track my tasks', 'how do i track tasks', 'how do i create a project',
      'how do i start a new project', 'how do i add a task', 'how do i manage projects', 'where are my projects',
      'where is the task list', 'how do projects work', 'how do i organize my work',
    ],
  },
  decide: {
    objects: ['decide', 'the decide page', 'approvals', 'my approvals', 'pending approvals', 'the approval queue', 'tool permissions', 'approval settings'],
    questions: [
      'what needs my approval', 'what is waiting for my approval', 'do i have anything to approve', 'is anything waiting on me to approve',
      'what do i need to approve', 'what decisions are waiting', 'how do i control tool permissions', 'how do i choose which tools need approval',
      'how do i make you ask before doing things', 'how do approvals work', 'pending decisions',
    ],
  },
  secretary: {
    objects: ['the secretary', 'secretary mode', 'the secretary tab', 'meeting notes', 'the meeting notes'],
    questions: [
      'can you take notes during my meeting', 'can you take meeting notes', 'how do i record a meeting', 'how do i transcribe a meeting',
      'how do i transcribe a call', 'can you listen to my meeting', 'how does secretary mode work', 'what is secretary mode',
      'can you write down what people say in my meeting', 'how do i get meeting notes',
    ],
  },
  settings: {
    objects: ['settings', 'the settings', 'preferences', 'the preferences', 'app settings', 'the settings window'],
    questions: [
      'how do i turn on dark mode', 'how do i change the theme', 'how do i change the appearance', 'how do i change settings',
      'how do i change how much memory sulla uses', 'how do i give sulla more ram', 'how do i change the cpu limit',
      'how do i make sulla start at login', 'how do i change startup settings', 'where are the preferences', 'where are the settings',
      'dark mode', 'light mode', 'change the theme', 'change the appearance',
    ],
  },
  models: {
    objects: ['model settings', 'the model settings', 'ai model settings', 'language model settings', 'the model picker', 'ai settings'],
    questions: [
      'how do i change the ai model', 'how do i change which model you use', 'how do i switch models', 'how do i pick a different model',
      'which model are you using', 'can i use chatgpt', 'can i use chatgpt instead', 'can i use gpt', 'can i use claude',
      'can i use gemini', 'can i use a local model', 'how do i run a local model', 'how do i use ollama', 'how do i add my openai key',
      'where do i put my openai key', 'where do i put my anthropic key', 'how do i add an api key for the model',
      'switch to claude', 'switch to gpt', 'switch to chatgpt', 'switch to a local model', 'use ollama', 'change the model', 'change models',
    ],
  },
  audio: {
    objects: ['audio settings', 'sound settings', 'voice settings', 'microphone settings', 'the audio settings'],
    questions: [
      'how do i change my microphone', 'how do i pick a different mic', 'my mic is wrong how do i change it', 'how do i change the input device',
      'how do i change the speaker', 'how do i change your voice', 'can i change your voice', 'can you use a different voice',
      'how do i make you talk', 'how do i turn on voice', 'change the microphone', 'change your voice', 'change the audio input',
    ],
  },
  welcome: {
    objects: ['the welcome screen', 'the welcome page', 'the getting started page', 'the tour', 'the intro'],
    questions: [
      'how do i get started', 'im new how do i get started', 'i just installed this what now', 'getting started', 'help me get started',
      'give me a tour', 'show me around', 'where do i start', 'what should i do first', 'how do i set this up', 'walk me through the app',
      'i am new here', 'first time using this',
    ],
  },
  chat: {
    objects: ['a new chat', 'a fresh chat', 'the chat', 'a new conversation', 'a blank chat'],
    questions: ['new chat', 'start a new chat', 'start a new conversation', 'start over in a new chat', 'begin a new conversation', 'fresh chat'],
  },
  browser: {
    objects: ['the browser', 'a browser', 'a browser tab', 'the web browser', 'a new browser tab'],
    questions: ['i want to browse the web', 'browse the internet', 'how do i browse the web', 'can you open a web browser', 'new browser tab', 'open a website'],
  },
  document: {
    objects: ['a new document', 'a blank document', 'a document', 'a new doc', 'the document editor'],
    questions: ['new document', 'new blank document', 'start a new document', 'create a blank document', 'i want to write a document', 'new doc'],
  },
};

// Popular integrations by display name: "connect X" / "how do i connect X" → integrations
const APPS = ['gmail', 'google calendar', 'google drive', 'google docs', 'google sheets', 'slack', 'notion', 'hubspot', 'salesforce',
  'shopify', 'stripe', 'quickbooks', 'github', 'gitlab', 'jira', 'trello', 'asana', 'monday', 'clickup', 'linear', 'airtable',
  'dropbox', 'discord', 'telegram', 'twilio', 'mailchimp', 'zoom', 'microsoft teams', 'outlook', 'onedrive', 'calendly',
  'zapier', 'wordpress', 'linkedin', 'twitter', 'facebook', 'instagram', 'youtube', 'openai', 'figma'];
const APP_FRAMES = ['connect {x}', 'connect my {x}', 'how do i connect {x}', 'how do i connect my {x}', 'can you connect to {x}',
  'can you connect to my {x}', 'link my {x}', 'link my {x} account', 'set up {x}', 'hook up {x}', 'does this work with {x}', 'integrate with {x}'];

// Every view gets the SAME frames so frame words ("how do i", "where is")
// carry no signal and the object decides. Each view is capped to a balanced
// size (deterministic spread sampling) so no intent crowds the neighbourhood.
const HOWTO = ['how do i use {x}', 'how does {x} work', 'what is {x}', 'tell me about {x}', 'help with {x}', 'i need {x}', 'i want {x}',
  'do you have {x}', 'is there {x}', 'where do {x} go', 'where do {x} live', 'get new {x}', 'find {x}', 'i want to set up {x}'];
const CAP = Number(process.env.REFLEX_CAP ?? 110);
const spread = (arr, n) => arr.length <= n ? arr : Array.from({ length: n }, (_, i) => arr[Math.floor(i * arr.length / n)]);
for (const [mode, v] of Object.entries(VIEWS)) {
  const framed = [...cross(OPEN, v.objects), ...cross(WHERE, v.objects), ...cross(HOWTO, v.objects)];
  const utts = [...new Set([...v.questions, ...spread([...new Set(framed)], Math.max(0, CAP - v.questions.length))])];
  add('open_tab', { mode }, utts);
}
add('open_tab', { mode: 'integrations' }, spread(cross(APP_FRAMES, APPS), CAP));

// ── Explicit actions (imperatives only) ─────────────────────────────────────
add('start', {}, ['start taking notes', 'start taking notes now', 'start secretary mode', 'turn on secretary mode', 'enter secretary mode',
  'start the secretary', 'begin taking notes', 'take notes now', 'start listening to the meeting', 'start meeting notes', 'start recording notes',
  'go into secretary mode', 'secretary mode on', 'start the notes', 'turn on the note taker', 'begin the notes']);
add('stop', {}, ['stop taking notes', 'stop secretary mode', 'turn off secretary mode', 'end secretary mode', 'exit secretary mode',
  'stop the secretary', 'stop listening', 'end the meeting notes', 'stop the meeting notes', 'you can stop taking notes', 'secretary mode off', 'stop the notes', 'turn off the note taker']);
add('status', {}, ['are you taking notes', 'are you still taking notes', 'is secretary mode on', 'are you listening right now',
  'are you still listening', 'is the secretary running', 'secretary status', 'are you recording the meeting', 'is the secretary on', 'is the note taker running', 'is note taking on']);
add('mic_stop', {}, ['turn off the mic', 'turn my mic off', 'turn off my microphone', 'mute the mic', 'mute my mic', 'stop the microphone',
  'mic off', 'microphone off', 'stop listening on the mic', 'disable the mic', 'shut off the mic']);
add('recorder_stop', {}, ['stop recording', 'stop the recording', 'stop screen recording', 'stop the screen recording', 'end the recording',
  'stop the recorder', 'finish the recording', 'recording off', 'end screen recording']);
add('speaker_stop', {}, ['stop capturing system audio', 'stop speaker capture', 'turn off speaker capture', 'stop recording computer audio']);
add('camera_release', {}, ['turn off the camera', 'turn my camera off', 'camera off', 'release the camera', 'stop using the camera', 'shut off the camera']);
add('audio_state', {}, ['is my mic on', 'is the microphone on', 'is my mic recording', 'is the mic live', 'are you recording audio', 'audio status']);
add('recorder_status', {}, ['am i being recorded', 'is the screen being recorded', 'is recording on', 'recording status', 'is the recorder running']);
add('camera_list', {}, ['what cameras do i have', 'what cameras can you see', 'list my cameras', 'list cameras', 'which cameras are connected', 'show my cameras']);
add('list_screens', {}, ['what screens do i have', 'list my screens', 'which displays can you see', 'list displays', 'what monitors do i have']);
add('teleprompter_open', {}, ['open the teleprompter', 'show the teleprompter', 'bring up the teleprompter', 'start the teleprompter', 'teleprompter on']);
add('teleprompter_close', {}, ['close the teleprompter', 'hide the teleprompter', 'turn off the teleprompter', 'teleprompter off', 'put away the teleprompter']);
add('teleprompter_status', {}, ['is the teleprompter open', 'is the teleprompter on', 'teleprompter status']);

add('project_report', {}, ['what got done today', 'what have we gotten done', 'what did we get done today', 'give me a status report',
  'status report', 'project report', 'give me the project report', 'daily report', 'what did you do today', 'what have you done today',
  'summary of today\'s work', 'what happened today', 'what did you complete today', 'what was finished today', 'what got finished']);
add('project_report', { hours: 168 }, ['what got done this week', 'what did we get done this week', 'weekly report', 'give me the weekly report',
  'this week\'s report', 'what did you do this week']);
add('list_project_items', { assignee: 'human' }, ['what tasks are on my plate', 'what\'s on my plate', 'what do i need to do', 'my tasks',
  'show my tasks', 'list my tasks', 'what tasks are assigned to me', 'what is waiting on me', 'what\'s my to do list', 'what should i work on', 'what is assigned to me', 'assigned to me', 'my assignments']);
add('list_project_items', { status: 'blocked' }, ['what\'s blocked', 'show blocked tasks', 'list blocked tasks', 'which tasks are stuck', 'what is stuck']);
add('list_project_items', { status: 'in_progress' }, ['what\'s in progress', 'what are you working on', 'show tasks in progress', 'list active tasks', 'what is being worked on']);
add('list_project_items', { kind: 'project' }, ['list my projects', 'what projects do i have', 'which projects do we have', 'show all projects', 'list all projects']);
add('list', {}, ['what tabs are open', 'what tabs do i have open', 'list my tabs', 'list open tabs', 'which tabs are open', 'show my open tabs']);
add('history', {}, ['show notifications', 'show me notifications you sent', 'notification history', 'what notifications did you send', 'list notifications', 'recent notifications']);
add('search_history', {}, ['show my browsing history', 'browser history', 'what sites did i visit', 'show browser history', 'my browsing history']);
add('search_conversations', { action: 'recent' }, ['show recent conversations', 'list recent chats', 'what did we talk about recently', 'my recent conversations']);
add('docker_ps', {}, ['what containers are running', 'list running containers', 'docker ps', 'show running containers', 'which containers are up']);

// ── Do-nothing: conversation, tasks for the model, complaints, edits ───────
add('none', {}, [
  'hello', 'hi', 'hey there', 'good morning', 'good evening', 'thanks', 'thank you', 'thank you so much', 'ok', 'okay', 'cool', 'great', 'nice',
  'yes', 'no', 'yes do it', 'go ahead', 'continue', 'keep going', 'stop', 'wait', 'cancel', 'never mind', 'nevermind', 'undo that',
  'what can you do', 'who are you', 'what are you', 'who made you', 'how are you', 'are you there', 'can you help me', 'i need help with something',
  'what is sulla', 'how does sulla work', 'is my data private', 'is this secure', 'how much does sulla cost', 'is sulla free',
  'write me an email', 'write a blog post', 'summarize this', 'translate this to spanish', 'explain this to me', 'what does this mean',
  'what is the weather', 'what time is it', 'tell me a joke', 'search the web for something', 'look this up', 'remind me later',
  'that did not work', 'that is wrong', 'try again', 'you made a mistake', 'fix it', 'why did that happen', 'what went wrong',
  'can you explain what you just did', 'what did you just do', 'build me a website', 'write some code', 'make a spreadsheet',
  // integration-named TASKS (the model does the work — don't open the integrations page)
  'send a message on slack', 'post this to slack', 'read my emails', 'check my email', 'send an email', 'draft an email reply',
  'what is on my calendar today', 'add an event to my calendar', 'create a notion page', 'update the hubspot contact',
  'upload this to google drive', 'make a github issue', 'tweet this', 'post this on linkedin',
  // edits and complaints about features (not navigation)
  'why is the vault not working', 'the vault is broken', 'delete that password', 'the integration disconnected', 'why did the integration fail',
  'disconnect gmail', 'remove that integration', 'my routine failed', 'why did the routine fail', 'delete that routine', 'pause the routine',
  'delete that agent', 'rename the agent', 'uninstall that plugin', 'remove the skill', 'create a project called marketing', 'add a task to buy milk',
  'mark that task done', 'delete the project', 'approve it', 'approve that', 'deny it', 'reject that', 'the meeting notes are wrong',
  'dark mode looks bad', 'the app is slow', 'the model is slow', 'your voice is annoying', 'you talk too much', 'close the settings',
  'close the vault', 'close this tab', 'close the chat', 'the browser crashed', 'why is the document empty',
]);

// Symmetric do-nothing frames: every feature object and app name also appears
// in complaint / build / task frames, so the object alone can never decide —
// the surrounding words must look like navigation.
const FEATURE_OBJECTS = ['the vault', 'passwords', 'integrations', 'the integration', 'routines', 'the routine', 'the workflow', 'workflows',
  'automations', 'history', 'agents', 'the agent', 'the marketplace', 'plugins', 'skills', 'projects', 'the project', 'tasks', 'approvals',
  'the secretary', 'meeting notes', 'settings', 'dark mode', 'light mode', 'the theme', 'the model', 'the ai model', 'the microphone',
  'the mic', 'audio', 'the voice', 'the chat', 'the browser', 'the document', 'the recording', 'the camera', 'notifications', 'the report'];
const COMPLAIN = ['{x} is broken', '{x} is not working', '{x} failed', '{x} is disabled', '{x} crashed', 'why is {x} broken',
  'why did {x} fail', 'fix {x}', '{x} has a bug', '{x} is slow', 'something is wrong with {x}', '{x} keeps failing', '{x} looks wrong',
  'build {x}', 'design {x} mockups', 'make {x} better', 'redesign {x}', 'give me {x} mockups', 'write code for {x}'];
const APP_TASKS = ['get it on {x}', 'push it to {x}', 'post it on {x}', 'send it to {x}', 'deploy it to {x}', 'upload it to {x}',
  'build it from {x}', 'read my {x}', 'check my {x}', 'search {x}', 'pull it from {x}', 'put it on {x}'];
add('none', {}, spread(cross(COMPLAIN, FEATURE_OBJECTS), Number(process.env.REFLEX_NEG_CAP ?? 300)));
add('none', {}, spread(cross(APP_TASKS, APPS), Number(process.env.REFLEX_NEG_CAP ?? 300)));
add('none', {}, ['got it', 'got it!', 'get it done', 'get to work', 'done', 'all done', 'is it done', 'did it work', 'what now',
  'so what do we do about it', 'where were we', 'do you need anything from me', 'what are the next steps', 'what is left']);

// Counter-examples: close/delete verbs must never map to the open action for the same object
for (const [mode, obj] of [['vault', 'the vault'], ['settings', 'settings'], ['routines', 'routines'], ['agents', 'agents'], ['marketplace', 'the marketplace'], ['projects', 'projects']]) {
  add('open_tab', { mode }, [`close ${ obj }`, `why is ${ obj } broken`], false);
}

// Drop exact duplicates (the same phrasing can come out of two frames).
const seen = new Set();
const examples = out.filter(e => {
  const key = `${ e.utterance.toLowerCase() }|${ e.tool }|${ JSON.stringify(e.params) }|${ e.positive }`;
  return !seen.has(key) && seen.add(key);
});
const seed = { version: 1, examples };
const target = process.argv[2] ?? new URL('../pkg/rancher-desktop/agent/reflex/seed/reflex-seed.json', import.meta.url);
fs.writeFileSync(target, `${ JSON.stringify(seed, null, 1) }\n`);
const byTool = examples.reduce((m, e) => ((m[`${ e.tool }${ e.params.mode ? ':' + e.params.mode : '' }`] = (m[`${ e.tool }${ e.params.mode ? ':' + e.params.mode : '' }`] ?? 0) + 1), m), {});
console.log(`seed: ${ examples.length } examples`);
console.log(Object.entries(byTool).map(([k, v]) => `${ k }=${ v }`).join('  '));
