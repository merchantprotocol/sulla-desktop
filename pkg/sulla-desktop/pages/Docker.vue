<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->

<!--
  The Docker tab. Markup and styles follow the approved mockup
  (Sulla Files: Projects/sulla-desktop/mockups/preferences-docker-kubernetes,
  screens 20–31) and share the Preferences tab's look via sulla-window.scss.
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useStore } from 'vuex';

import DockerShell from '@pkg/components/DockerShell.vue';
import {
  ago, gb, groupSubtitle, isSecretKey, parseSize, readableSize, splitIO, upFor,
} from '@pkg/components/docker/format';
import {
  cleanName, displayProject, flatPorts, imageName as splitImageName, isNetworkWide, reachableFrom,
} from '@pkg/components/docker/helpers';
import PrefIcon from '@pkg/components/settings/PrefIcon.vue';
import DockerSection from '@pkg/components/settings/sections/DockerSection.vue';
import { useEngineSettings } from '@pkg/composables/preferences/useEngineSettings';
import type { Container, Volume } from '@pkg/store/container-engine';
import initDockerClient from '@pkg/utils/dockerClient';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{
  /** Page to show next (`containers`, `images`, `snapshots`…), from a menu, link or the agent. */
  requestedSection?: string;
}>();
const emit = defineEmits<(e: 'section-consumed') => void>();

const store = useStore();
const engine = useEngineSettings();

/* ── Where we are ── */
type Section = 'containers' | 'container' | 'images' | 'volumes' | 'networks' | 'ports' | 'snapshots' | 'options' |
  'add-image' | 'create-snapshot';
const SECTIONS: Section[] = ['containers', 'images', 'volumes', 'networks', 'ports', 'snapshots', 'options', 'add-image', 'create-snapshot'];
const view = ref<{ section: Section, id?: string, tab?: string }>({ section: 'containers' });
const query = ref('');
const error = ref('');
const section = computed(() => view.value.section);
const navActive = computed(() => ({ container: 'containers', 'add-image': 'images', 'create-snapshot': 'snapshots' } as Record<string, string>)[section.value] ?? section.value);

function go(target: Section) {
  view.value = { section: target };
  query.value = '';
  document.querySelector('.sulla-docker .main')?.scrollTo({ top: 0 });
}

watch(() => props.requestedSection, (name) => {
  if (!name) {
    return;
  }
  const target = (name.toLowerCase().replace(/^docker/, '') || 'options') as Section;

  if (SECTIONS.includes(target)) {
    go(target);
  }
  emit('section-consumed');
}, { immediate: true });

const matches = (...values: unknown[]) => {
  const q = query.value.trim().toLowerCase();

  return !q || values.join(' ').toLowerCase().includes(q);
};

async function exec(command: string, args: string[]): Promise<any> {
  return await window.ddClient?.docker.cli.exec(command, args, { cwd: '/' });
}
async function execJsonLines(command: string, args: string[]): Promise<any[]> {
  try {
    return (await exec(command, args))?.parseJsonLines?.() || [];
  } catch {
    return [];
  }
}
function fail(e: any) {
  error.value = e?.stderr || e?.message || String(e);
}
async function confirm(title: string, detail: string, button: string): Promise<boolean> {
  const result = await ipcRenderer.invoke('show-message-box', {
    type: 'question', title, message: title, detail, buttons: [button, 'Cancel'], cancelId: 1, defaultId: 1,
  });

  return result?.response === 0;
}
function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => undefined);
}

/* ── Containers ── */
const containers = computed<Record<string, Container> | null>(() => store.state['container-engine'].containers);
const volumeMap = computed<Record<string, Volume> | null>(() => store.state['container-engine'].volumes);
const namespace = computed(() => store.getters['container-engine/namespace']);
const containerRows = computed(() => Object.values(containers.value || {}));
const isUp = (c: Container) => c.state === 'running' || c.state === 'restarting';
const runningCount = computed(() => containerRows.value.filter(c => c.state === 'running').length);
const stoppedCount = computed(() => containerRows.value.length - runningCount.value);
const containerFilter = ref<'all' | 'run' | 'stop'>('all');
const collapsed = ref<Record<string, boolean>>({});

function dotClass(c: Container) {
  return { running: 'dot', restarting: 'dot warn', paused: 'dot warn', dead: 'dot bad' }[c.state as string] ??
    ((c.state as string) === 'exited' && exitCode(c) ? 'dot bad' : 'dot off');
}
function statusClass(c: Container) {
  return { restarting: 'warnc', paused: 'warnc', dead: 'badc' }[c.state as string] ?? 'muted';
}
function exitCode(c: Container): number {
  return Number(/Exited \((\d+)\)/.exec(rowInfo.value[c.id]?.Status ?? '')?.[1] ?? 0);
}
function statusText(c: Container) {
  const raw = rowInfo.value[c.id]?.Status as string | undefined;

  if (c.state === 'running') {
    return `Running · ${ upFor(c.started) }`;
  }
  if (c.state === 'restarting') {
    const code = /Restarting \((\d+)\)/.exec(raw ?? '')?.[1];

    return `Restarting${ code && code !== '0' ? ` · exit ${ code }` : '' }`;
  }
  if (raw?.startsWith('Exited')) {
    const when = raw.replace(/^Exited \(\d+\)\s*/, '');

    return exitCode(c) ? `Exited (${ exitCode(c) }) · ${ when }` : `Stopped · ${ when }`;
  }

  return c.state ? c.state[0].toUpperCase() + c.state.slice(1) : 'Unknown';
}

// Sulla first, Compose projects next, loose containers last, as in the mockup.
const groupRank = (name: string) => (name === 'sulla' ? 0 : name === 'Standalone Containers' ? 2 : 1);
const groups = computed(() => {
  const order = new Map<string, Container[]>();

  for (const c of containerRows.value) {
    order.set(c.projectGroup, [...(order.get(c.projectGroup) || []), c]);
  }

  return [...order]
    .map(([name, all]) => ({
      name,
      all,
      project: name !== 'Standalone Containers' && !name.includes('/'),
      running: all.filter(c => c.state === 'running').length,
      items:   all
        .filter(c => containerFilter.value === 'all' || (containerFilter.value === 'run') === (c.state === 'running'))
        .filter(c => matches(cleanName(c.containerName), c.imageName))
        .sort((a, b) => cleanName(a.containerName).localeCompare(cleanName(b.containerName))),
    }))
    .filter(g => g.items.length)
    .sort((a, b) => groupRank(a.name) - groupRank(b.name) || a.name.localeCompare(b.name));
});

async function containerCommand(command: string, ids: string[]) {
  try {
    await exec(command, ids);
    await store.dispatch('container-engine/fetchContainers').catch(() => undefined);
  } catch (e) {
    fail(e);
  }
}
const startOrStop = (c: Container) => containerCommand(isUp(c) ? 'stop' : 'start', [c.id]);
const restart = (c: Container) => containerCommand('restart', [c.id]);
const groupStartOrStop = (g: { all: Container[], running: number }) => containerCommand(g.running ? 'stop' : 'start', g.all.map(c => c.id));
const groupRestart = (g: { all: Container[] }) => containerCommand('restart', g.all.map(c => c.id));
async function removeContainer(c: Container) {
  if (await confirm(`Delete ${ cleanName(c.containerName) }?`, 'The container is stopped and removed. Its volumes are kept.', 'Delete')) {
    await containerCommand('rm', ['-f', c.id]);
    if (section.value === 'container') {
      go('containers');
    }
  }
}
function openContainer(c: Container, tab = 'logs') {
  view.value = { section: 'container', id: c.id, tab };
  document.querySelector('.sulla-docker .main')?.scrollTo({ top: 0 });
}
function setTab(tab: string) {
  view.value = { ...view.value, tab };
}

/* `docker ps` adds the status line ("Exited (1) 2 hours ago") and mounts the store doesn't keep. */
const rowInfo = ref<Record<string, any>>({});
async function loadRowInfo() {
  const rows = await execJsonLines('ps', ['-a', '--no-trunc', '--format={{json .}}']);

  rowInfo.value = Object.fromEntries(rows.map(r => [r.ID, r]));
}

/* Live CPU and memory for every running container. */
const usage = ref<Record<string, { cpu: number, mem: number }>>({});
async function loadUsage() {
  if (!runningCount.value) {
    usage.value = {};

    return;
  }
  const rows = await execJsonLines('stats', ['--no-stream', '--no-trunc', '--format={{json .}}']);

  usage.value = Object.fromEntries(rows.map(r => [r.ID, {
    cpu: parseFloat(r.CPUPerc) || 0,
    mem: parseSize(String(r.MemUsage || '').split('/')[0]),
  }]));
}
const usageFor = (c: Container) => usage.value[c.id];

/* ── Container detail ── */
const selected = computed(() => containers.value?.[String(view.value.id)] ||
  containerRows.value.find(c => cleanName(c.containerName) === view.value.id));
const detailTab = computed(() => view.value.tab || 'logs');
const DETAIL_TABS = ['logs', 'shell', 'ports', 'stats', 'details'];
const selectedPorts = computed(() => (selected.value ? flatPorts(selected.value) : []));

const inspect = ref<any>(null);
async function loadInspect() {
  inspect.value = null;
  if (!selected.value) {
    return;
  }
  try {
    inspect.value = JSON.parse((await exec('inspect', [selected.value.id]))?.stdout || '[]')[0] ?? null;
  } catch {
    inspect.value = null;
  }
}
const detailRows = computed<[string, string][]>(() => {
  const c = selected.value;
  const i = inspect.value;

  if (!c) {
    return [];
  }
  const rows: [string, string][] = [
    ['Container ID', c.id.slice(0, 12)],
    ['Image', c.imageName],
  ];

  if (i) {
    rows.push(['Created', new Date(i.Created).toLocaleString()]);
    rows.push(['Command', [i.Path, ...(i.Args || [])].join(' ')]);
    rows.push(['Restart policy', i.HostConfig?.RestartPolicy?.Name || 'no']);
  }
  rows.push(['Project', `${ displayProject(c.projectGroup) } · ${ groupSubtitle(c.projectGroup, c.labels) }`]);
  for (const [name, net] of Object.entries<any>(i?.NetworkSettings?.Networks || {})) {
    rows.push(['Network', `${ name }${ net.IPAddress ? ` · ${ net.IPAddress }` : '' }`]);
  }
  for (const m of i?.Mounts || []) {
    rows.push([m.Type === 'volume' ? 'Volume' : 'Folder', `${ m.Name || m.Source } → ${ m.Destination }`]);
  }
  for (const env of i?.Config?.Env || []) {
    const at = env.indexOf('=');
    const key = env.slice(0, at);

    if (!/^(PATH|HOME|HOSTNAME|TERM|LANG|GPG_KEY|PYTHON_.*|NODE_VERSION|YARN_VERSION)$/.test(key)) {
      rows.push([key, isSecretKey(key) ? '••••••••••••' : env.slice(at + 1)]);
    }
  }
  if (i?.Config?.Healthcheck?.Test) {
    rows.push(['Health check', `${ i.Config.Healthcheck.Test.slice(1).join(' ') }${ i.State?.Health?.Status ? ` · ${ i.State.Health.Status }` : '' }`]);
  }

  return rows;
});
const health = computed(() => inspect.value?.State?.Health?.Status as string | undefined);
// "Running · healthy · up 8 hours", as in the mockup's container header.
const detailStatus = computed(() => {
  const c = selected.value;

  if (!c) {
    return '';
  }

  return c.state === 'running' ? ['Running', health.value, `up ${ upFor(c.started) }`].filter(Boolean).join(' · ') : statusText(c);
});

/* Logs: streamed from `docker logs`, filtered here. */
const logLines = ref<{ ts: string, text: string, level: 'i' | 'w' | 'e' }[]>([]);
const logFollow = ref(true);
const logTimestamps = ref(true);
const logLevel = ref('all');
const logQuery = ref('');
const logEl = ref<HTMLElement>();
let logProcess: any;
let logBuffer = '';

function levelOf(text: string): 'i' | 'w' | 'e' {
  if (/\b(error|fatal|panic|exception|err)\b/i.test(text)) {
    return 'e';
  }

  return /\b(warn|warning)\b/i.test(text) ? 'w' : 'i';
}
function pushLog(chunk: string) {
  logBuffer += chunk;
  const parts = logBuffer.split('\n');

  logBuffer = parts.pop() ?? '';
  for (const line of parts) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z?)\s(.*)$/.exec(line);
    const text = m ? m[2] : line;

    logLines.value.push({ ts: m ? m[1].replace('T', ' ').replace(/(\.\d{3})\d*Z?$/, '$1') : '', text, level: levelOf(text) });
  }
  if (logLines.value.length > 5000) {
    logLines.value.splice(0, logLines.value.length - 5000);
  }
  if (logFollow.value) {
    requestAnimationFrame(() => logEl.value?.scrollTo({ top: logEl.value.scrollHeight }));
  }
}
function stopLogs() {
  logProcess?.close?.();
  logProcess = undefined;
}
function startLogs() {
  stopLogs();
  logLines.value = [];
  logBuffer = '';
  if (!selected.value || !window.ddClient) {
    return;
  }
  const options: any = {
    cwd:    '/',
    stream: {
      splitOutputLines: false,
      onOutput:         (data: any) => pushLog(data.stdout || data.stderr || ''),
      onError:          (e: any) => pushLog(`${ e?.message || e }\n`),
      onClose:          () => undefined,
    },
  };

  if (namespace.value) {
    options.namespace = namespace.value;
  }
  logProcess = window.ddClient.docker.cli.exec('logs', ['--timestamps', '--tail', '1000', ...(isUp(selected.value) ? ['--follow'] : []), selected.value.id], options);
}
const shownLogs = computed(() => {
  const q = logQuery.value.trim().toLowerCase();

  return logLines.value.filter(l => (logLevel.value === 'all' || (logLevel.value === 'warn' ? l.level !== 'i' : l.level === 'e')) &&
    (!q || l.text.toLowerCase().includes(q)));
});
const logText = () => shownLogs.value.map(l => (logTimestamps.value && l.ts ? `${ l.ts }  ${ l.text }` : l.text)).join('\n');
function downloadLogs() {
  const a = document.createElement('a');

  a.href = URL.createObjectURL(new Blob([logText()], { type: 'text/plain' }));
  a.download = `${ cleanName(selected.value?.containerName || 'container') }.log`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* Stats: polled every 2 s while the tab is open, kept for the last 2 minutes. */
const POINTS = 60;
const history = ref({ cpu: [] as number[], mem: [] as number[], net: [] as number[], disk: [] as number[] });
const latest = ref({ cpuOf: '', memLimit: '', netTotal: '', diskTotal: '' });
let lastIO: { t: number, net: number, disk: number } | undefined;
async function loadStats() {
  const c = selected.value;

  if (!c || !isUp(c)) {
    return;
  }
  const r = (await execJsonLines('stats', ['--no-stream', '--format={{json .}}', c.id]))[0];

  if (!r) {
    return;
  }
  const now = Date.now();
  const [memUsed, memLimit] = String(r.MemUsage || '').split('/');
  const net = splitIO(r.NetIO);
  const disk = splitIO(r.BlockIO);
  const h = history.value;
  const push = (list: number[], value: number) => {
    list.push(value);
    if (list.length > POINTS) {
      list.shift();
    }
  };

  push(h.cpu, parseFloat(r.CPUPerc) || 0);
  push(h.mem, parseSize(memUsed) / 2 ** 20);
  if (lastIO) {
    const seconds = Math.max(0.5, (now - lastIO.t) / 1000);

    push(h.net, Math.max(0, net.in - lastIO.net) / 1024 / seconds);
    push(h.disk, Math.max(0, disk.out - lastIO.disk) / 2 ** 20 / seconds);
  }
  lastIO = { t: now, net: net.in, disk: disk.out };
  latest.value = {
    cpuOf:     `of ${ settings.value?.virtualMachine?.numberCPUs ?? '?' } cores`,
    memLimit:  memLimit ? `of ${ readableSize(parseSize(memLimit)) }` : '',
    netTotal:  `${ readableSize(net.in) } total`,
    diskTotal: `${ readableSize(disk.out) } total`,
  };
}
function resetStats() {
  history.value = { cpu: [], mem: [], net: [], disk: [] };
  lastIO = undefined;
}
const CHART_W = 400;
const CHART_H = 110;
function chart(data: number[], floor: number) {
  const max = Math.max(floor, ...data) * 1.15;
  const n = Math.max(data.length, 2);
  const pts = data.map((v, i) => [(i + POINTS - data.length) / (POINTS - 1) * CHART_W, CHART_H - v / max * (CHART_H - 6)]);
  const line = pts.map((p, i) => `${ i ? 'L' : 'M' }${ p[0].toFixed(1) } ${ p[1].toFixed(1) }`).join(' ');
  const grid = [0.25, 0.5, 0.75].map(g => CHART_H - g * (CHART_H - 6));

  return { line, area: pts.length ? `${ line } L ${ pts[pts.length - 1][0] } ${ CHART_H } L ${ pts[0][0] } ${ CHART_H } Z` : '', grid, max, n };
}
const fmt = (v: number | undefined, unit: string, digits = 1) => (v === undefined ? '—' : `${ v.toFixed(digits) }${ unit }`);
const charts = computed(() => {
  const h = history.value;
  const last = (l: number[]) => l[l.length - 1];

  return [
    { id: 'cpu', title: 'CPU', value: fmt(last(h.cpu), '%'), note: latest.value.cpuOf, unit: '%', data: h.cpu, ...chart(h.cpu, 5) },
    { id: 'mem', title: 'Memory', value: fmt(last(h.mem), ' MB', 0), note: latest.value.memLimit, unit: ' MB', data: h.mem, ...chart(h.mem, 10) },
    { id: 'net', title: 'Network received', value: fmt(last(h.net), ' KB/s'), note: latest.value.netTotal, unit: ' KB/s', data: h.net, ...chart(h.net, 5) },
    { id: 'disk', title: 'Disk writes', value: fmt(last(h.disk), ' MB/s'), note: latest.value.diskTotal, unit: ' MB/s', data: h.disk, ...chart(h.disk, 0.5) },
  ];
});
const hover = ref<{ id: string, x: number, left: number, text: string } | null>(null);
function onChartMove(event: MouseEvent, c: { id: string, data: number[], unit: string }) {
  const box = (event.currentTarget as SVGElement).getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  const index = Math.round(fraction * (POINTS - 1)) - (POINTS - c.data.length);

  if (index < 0 || index >= c.data.length) {
    hover.value = null;

    return;
  }
  const secondsAgo = (c.data.length - 1 - index) * 2;

  hover.value = {
    id:   c.id,
    x:    (index + POINTS - c.data.length) / (POINTS - 1) * CHART_W,
    left: event.clientX - box.left + 14,
    text: `<b>${ c.data[index].toFixed(c.unit === ' MB' ? 0 : 1) }${ c.unit }</b> · ${ secondsAgo ? `${ secondsAgo } s ago` : 'now' }`,
  };
}

/* ── Images ── */
const images = ref<any[]>([]);
const imageFilter = ref<'all' | 'used' | 'unused'>('all');
async function loadImages() {
  try {
    images.value = (await window.ddClient?.docker.listImages({ all: false })) || [];
  } catch (e) {
    fail(e);
  }
}
const imageRows = computed(() => images.value.map((image) => {
  const { repository, tag } = splitImageName(image);
  const tags: string[] = image.RepoTags || [];
  const users = containerRows.value
    .filter(c => tags.includes(c.imageName) || tags.includes(`${ c.imageName }:latest`) || image.Id === c.imageName || image.Id?.includes(c.imageName))
    .map(c => cleanName(c.containerName));

  return {
    id: image.Id as string, repository, tag, size: image.Size as number, created: image.Created * 1000, users, ref: tags[0] || image.Id,
  };
}).sort((a, b) => b.size - a.size));
const unusedImages = computed(() => imageRows.value.filter(i => !i.users.length));
const shownImages = computed(() => imageRows.value
  .filter(i => imageFilter.value === 'all' || (imageFilter.value === 'used') === !!i.users.length)
  .filter(i => matches(i.repository, i.tag, i.users.join(' '))));
const usedBy = (users: string[]) => (users.length > 1 ? `${ users[0] } and ${ users.length - 1 } more` : users[0]);
async function runImage(ref: string) {
  if (await confirm(`Run ${ ref }?`, 'Starts a new container from this image in the background.', 'Run')) {
    await containerCommand('run', ['-d', ref]);
    go('containers');
  }
}
async function removeImage(i: { ref: string, users: string[] }) {
  if (await confirm(`Delete ${ i.ref }?`, i.users.length ? `It's used by ${ i.users.join(', ') }. Those containers must be removed first.` : 'You can pull it again later.', 'Delete')) {
    try {
      await exec('rmi', [i.ref]);
    } catch (e) {
      fail(e);
    }
    await loadImages();
  }
}
async function pruneImages() {
  const size = readableSize(unusedImages.value.reduce((n, i) => n + i.size, 0));

  if (await confirm('Clean up unused images?', `Removes ${ unusedImages.value.length } images no container uses, about ${ size }.`, 'Clean up')) {
    try {
      await exec('image', ['prune', '-a', '-f']);
    } catch (e) {
      fail(e);
    }
    await loadImages();
  }
}

/* Pull or build */
const pullName = ref('');
const pullOutput = ref('');
const pullBusy = ref(false);
function onImageOutput(_e: any, data: string) {
  pullOutput.value += data;
}
function onImageEnded(_e: any, status: number) {
  pullBusy.value = false;
  pullOutput.value += status === 0 ? '\nDone.\n' : `\nFailed (exit ${ status }).\n`;
  void loadImages();
}
function pullOrBuild(action: 'pull' | 'build') {
  const name = pullName.value.trim();

  if (!name || pullBusy.value) {
    return;
  }
  pullBusy.value = true;
  pullOutput.value = `${ action } ${ name }\n`;
  ipcRenderer.send(action === 'pull' ? 'do-image-pull' : 'do-image-build', name);
}

/* ── Volumes ── */
const volumeSizes = ref<Record<string, number>>({});
async function loadVolumeSizes() {
  try {
    const df = JSON.parse((await exec('system', ['df', '-v', '--format', '{{json .}}']))?.stdout || '{}');

    volumeSizes.value = Object.fromEntries((df.Volumes || []).map((v: any) => [v.Name, parseSize(v.Size)]));
  } catch {
    volumeSizes.value = {};
  }
}
/* Which containers use each volume, and where it's mounted inside them. */
const volumeMounts = ref<Record<string, { users: string[], dest: string }>>({});
async function loadVolumeMounts() {
  const ids = Object.keys(rowInfo.value);

  if (!ids.length) {
    return;
  }
  try {
    const all = JSON.parse((await exec('inspect', ['--type', 'container', ...ids]))?.stdout || '[]');
    const mounts: Record<string, { users: string[], dest: string }> = {};

    for (const c of all) {
      for (const m of c.Mounts || []) {
        if (m.Type === 'volume' && m.Name) {
          const entry = (mounts[m.Name] ||= { users: [], dest: m.Destination });

          entry.users.push(cleanName(c.Name));
        }
      }
    }
    volumeMounts.value = mounts;
  } catch {
    volumeMounts.value = {};
  }
}
const isAnonymous = (name: string) => /^[0-9a-f]{64}$/.test(name);
const volumeRows = computed(() => Object.values(volumeMap.value || {}).map(v => ({
  name:  v.Name,
  size:  volumeSizes.value[v.Name] ?? v.UsageData?.Size,
  users: volumeMounts.value[v.Name]?.users ?? [],
  mount: volumeMounts.value[v.Name]?.dest ?? '—',
})).sort((a, b) => (b.size ?? 0) - (a.size ?? 0)));
const namedVolumes = computed(() => volumeRows.value.filter(v => !isAnonymous(v.name) || v.users.length).filter(v => matches(v.name, v.users.join(' '))));
const looseVolumes = computed(() => volumeRows.value.filter(v => isAnonymous(v.name) && !v.users.length));
const volumesTotal = computed(() => volumeRows.value.reduce((n, v) => n + (v.size ?? 0), 0));
async function removeVolumes(names: string[], title: string) {
  if (await confirm(title, 'The data in them is deleted for good.', 'Delete')) {
    try {
      await exec('volume', ['rm', ...names]);
    } catch (e) {
      fail(e);
    }
    await refresh();
  }
}
async function pruneVolumes() {
  if (await confirm('Clean up unused volumes?', 'Removes every volume no container uses. The data in them is deleted for good.', 'Clean up')) {
    try {
      await exec('volume', ['prune', '-a', '-f']);
    } catch (e) {
      fail(e);
    }
    await refresh();
  }
}

/* ── Networks ── */
const networks = ref<any[]>([]);
const BUILT_IN = ['bridge', 'host', 'none'];
async function loadNetworks() {
  const ids = (await execJsonLines('network', ['ls', '--format={{json .}}'])).map(n => n.ID);

  if (!ids.length) {
    networks.value = [];

    return;
  }
  try {
    networks.value = JSON.parse((await exec('network', ['inspect', ...ids]))?.stdout || '[]');
  } catch (e) {
    fail(e);
  }
}
const networkRows = computed(() => networks.value.map((n) => {
  const count = Object.keys(n.Containers || {}).length;

  return {
    id:      n.Id as string,
    name:    n.Name as string,
    driver:  n.Driver as string,
    subnet:  n.IPAM?.Config?.[0]?.Subnet || '—',
    count,
    builtIn: BUILT_IN.includes(n.Name),
    from:    BUILT_IN.includes(n.Name) ? 'Docker' : displayProject(n.Labels?.['com.docker.compose.project'] || '—'),
  };
}).sort((a, b) => Number(a.builtIn) - Number(b.builtIn) || b.count - a.count || a.name.localeCompare(b.name)));
const unusedNetworks = computed(() => networkRows.value.filter(n => !n.builtIn && !n.count).length);
const shownNetworks = computed(() => networkRows.value.filter(n => matches(n.name, n.driver, n.from, n.subnet)));
async function removeNetwork(id: string, name: string) {
  if (await confirm(`Delete ${ name }?`, 'Containers can no longer join it.', 'Delete')) {
    try {
      await exec('network', ['rm', id]);
    } catch (e) {
      fail(e);
    }
    await loadNetworks();
  }
}
async function pruneNetworks() {
  if (await confirm('Clean up unused networks?', `Removes ${ unusedNetworks.value } networks no container uses.`, 'Clean up')) {
    try {
      await exec('network', ['prune', '-f']);
    } catch (e) {
      fail(e);
    }
    await loadNetworks();
  }
}

/* New volume / new network */
const ask = ref<{ kind: 'volume' | 'network' } | null>(null);
const askName = ref('');
async function createFromAsk() {
  const a = ask.value;

  if (!a || !askName.value.trim()) {
    return;
  }
  try {
    await exec(a.kind, ['create', askName.value.trim()]);
    ask.value = null;
    await refresh();
  } catch (e) {
    fail(e);
  }
}

/* ── Ports ── */
const portFilter = ref<'all' | 'open'>('all');
const portRows = computed(() => containerRows.value
  .filter(c => c.state === 'running')
  .flatMap(c => flatPorts(c).map(port => ({ c, port })))
  .sort((a, b) => Number(a.port.hostPort) - Number(b.port.hostPort)));
const openPortCount = computed(() => portRows.value.filter(r => isNetworkWide(r.port.hostIp)).length);
const shownPorts = computed(() => portRows.value
  .filter(r => portFilter.value === 'all' || isNetworkWide(r.port.hostIp))
  .filter(r => matches(r.port.hostPort, cleanName(r.c.containerName), r.c.projectGroup)));
function openPort(port: { hostPort: string }) {
  ipcRenderer.send('open-url-in-app', `http://localhost:${ port.hostPort }`);
}
function uniquePorts(c: Container) {
  const seen = new Set<string>();

  return flatPorts(c).filter(p => !seen.has(p.hostPort) && seen.add(p.hostPort));
}

/* ── Snapshots ── */
const snapshots = computed<any[]>(() => store.getters['snapshots/list'] || []);
const shownSnapshots = computed(() => snapshots.value.filter(s => matches(s.name, s.description)));
const snapshotName = ref('');
const snapshotDescription = ref('');
const snapshotBusy = ref(false);
async function createSnapshot() {
  const name = snapshotName.value.trim();

  if (!name || snapshotBusy.value) {
    return;
  }
  snapshotBusy.value = true;
  error.value = '';
  try {
    const result = await store.dispatch('snapshots/create', { name, description: snapshotDescription.value.trim() });

    if (result) {
      error.value = String(result);
    } else {
      snapshotName.value = '';
      snapshotDescription.value = '';
      go('snapshots');
    }
  } finally {
    snapshotBusy.value = false;
  }
}
async function restoreSnapshot(name: string) {
  if (await confirm(`Restore ${ name }?`, 'Docker goes back to how it was when this snapshot was taken. Anything newer is lost.', 'Restore')) {
    const result = await store.dispatch('snapshots/restore', name);

    if (result) {
      error.value = String(result);
    }
  }
}
async function deleteSnapshot(name: string) {
  if (await confirm(`Delete ${ name }?`, 'You can’t restore it after this.', 'Delete')) {
    const result = await store.dispatch('snapshots/delete', name);

    if (result) {
      error.value = String(result);
    }
  }
}
// While a snapshot is taken or restored the backend is locked; show the blocking progress dialog.
function onBackendLocked(_e: any, action?: string) {
  ipcRenderer.invoke('show-snapshots-blocking-dialog', {
    window: { buttons: [], cancelId: 1 },
    format: {
      header:            action || 'Working on a snapshot',
      message:           'Docker is paused until this finishes.',
      showProgressBar:   true,
      snapshotEventType: 'backend-lock',
    },
  });
}
function onBackendUnlocked() {
  ipcRenderer.send('dialog/close', { dialog: 'SnapshotsDialog', snapshotEventType: 'backend-lock' });
}

/* ── Sidebar footer: engine state and usage ── */
const settings = ref<any>();
const backendState = ref('');
const diskUsed = ref<number>();
function readSettings(_e: any, value: any) {
  settings.value = value;
}
// The Sulla runtime reports DISABLED (not STARTED) once the container engine is ready.
const backendReady = computed(() => backendState.value === 'STARTED' || backendState.value === 'DISABLED');
const backendBusy = computed(() => ['STARTING', 'STOPPING', 'STOPPED'].includes(backendState.value));
function onBackendState(_e: any, state: any) {
  const wasReady = backendReady.value;

  backendState.value = String(state);
  if (backendReady.value && !wasReady) {
    void connect();
  }
}
// Sent once the backend can run Docker commands for this window, including after a restart.
function onBackendReady() {
  void connect();
}
const engineLabel = computed(() => ({
  STARTED: 'Docker is running', STARTING: 'Docker is starting', STOPPING: 'Docker is stopping', STOPPED: 'Docker is stopped', ERROR: 'Docker has a problem', DISABLED: 'Docker is running',
} as Record<string, string>)[backendState.value] ?? 'Docker');
const engineDot = computed(() => ({ STARTED: 'dot', DISABLED: 'dot', STARTING: 'dot warn', STOPPING: 'dot warn', ERROR: 'dot bad' } as Record<string, string>)[backendState.value] ?? 'dot off');
const meters = computed(() => {
  const vm = settings.value?.virtualMachine ?? {};
  const memGB = Object.values(usage.value).reduce((n, u) => n + u.mem, 0) / 2 ** 30;
  const cores = vm.numberCPUs || 0;
  const cpu = Object.values(usage.value).reduce((n, u) => n + u.cpu, 0) / Math.max(1, cores);
  const diskGB = (diskUsed.value ?? 0) / 2 ** 30;
  const diskSize = parseFloat(settings.value?.experimental?.virtualMachine?.diskSize) || 0;
  const pct = (v: number, of: number) => `${ of ? Math.min(100, Math.round(v / of * 100)) : 0 }%`;

  return [
    { label: 'Memory', value: gb(memGB), of: vm.memoryInGB ? `of ${ vm.memoryInGB } GB` : '', width: pct(memGB, vm.memoryInGB) },
    { label: 'CPU', value: `${ Math.round(cpu) }%`, of: cores ? `of ${ cores } cores` : '', width: `${ Math.min(100, Math.round(cpu)) }%` },
    { label: 'Disk', value: diskUsed.value === undefined ? '—' : gb(diskGB, 0), of: diskSize ? `of ${ diskSize } GB` : '', width: pct(diskGB, diskSize) },
  ];
});
async function loadDiskUsed() {
  const rows = await execJsonLines('system', ['df', '--format={{json .}}']);

  if (rows.length) {
    diskUsed.value = rows.reduce((n, r) => n + parseSize(r.Size), 0);
  }
}
const kubernetesOn = computed(() => !!settings.value?.kubernetes?.enabled);
async function restartDocker() {
  if (await confirm('Restart Docker?', 'Containers with a restart policy come back on their own.', 'Restart')) {
    ipcRenderer.send('k8s-restart');
  }
}
function openKubernetesSettings() {
  ipcRenderer.send('preferences-open', 'docker');
}

const navCounts = computed(() => ({
  containers: runningCount.value,
  images:     images.value.length,
  volumes:    Object.keys(volumeMap.value || {}).length,
  networks:   networks.value.length,
  ports:      portRows.value.length,
}));
const NAV: { id: Section, icon: string, label: string, count?: keyof typeof navCounts.value }[] = [
  { id: 'containers', icon: 'box', label: 'Containers', count: 'containers' },
  { id: 'images', icon: 'layers', label: 'Images', count: 'images' },
  { id: 'volumes', icon: 'disk', label: 'Volumes', count: 'volumes' },
  { id: 'networks', icon: 'net', label: 'Networks', count: 'networks' },
  { id: 'ports', icon: 'plug', label: 'Ports', count: 'ports' },
];

/* ── Loading ── */
// The store holds one subscription at a time, and switching its type clears the other list,
// so containers stay subscribed and volumes are fetched with the same client.
async function subscribe() {
  if (window.ddClient) {
    await store.dispatch('container-engine/subscribe', { type: 'containers', client: window.ddClient, owner: 'sulla-docker' });
  }
}
const loadVolumes = () => store.dispatch('container-engine/fetchVolumes');
// The tab is restored at launch, before the backend can run Docker commands; (re)connect once it can.
async function connect() {
  if (backendBusy.value) {
    return;
  }
  await subscribe().catch(fail);
  await refresh();
}
async function refresh() {
  error.value = '';
  try {
    await Promise.all([
      loadRowInfo(),
      loadImages(),
      loadNetworks(),
      loadVolumes(),
      section.value === 'volumes' ? loadVolumeSizes() : undefined,
      section.value === 'volumes' ? loadRowInfo().then(loadVolumeMounts) : undefined,
      section.value === 'snapshots' ? store.dispatch('snapshots/fetch') : undefined,
    ]);
  } catch (e) {
    fail(e);
  }
}
async function loadPreferences() {
  try {
    await store.dispatch('preferences/fetchPreferences');
    await store.dispatch('preferences/fetchLocked');
  } catch { /* the Options page shows its own state */ }
}

// The Docker client and backend credentials used to come from the Docker window's layout.
if (!window.ddClient) {
  initDockerClient();
}

let detailTimer: ReturnType<typeof setInterval> | undefined;
let usageTimer: ReturnType<typeof setInterval> | undefined;

watch(() => [section.value, view.value.id], () => {
  void refresh();
  if (section.value === 'container') {
    void loadInspect();
  }
  if (section.value === 'options') {
    void loadPreferences();
  }
});
watch(() => [section.value, view.value.id, detailTab.value], () => {
  clearInterval(detailTimer);
  detailTimer = undefined;
  stopLogs();
  resetStats();
  hover.value = null;
  if (section.value !== 'container') {
    return;
  }
  if (detailTab.value === 'logs') {
    startLogs();
  } else if (detailTab.value === 'stats') {
    void loadStats();
    detailTimer = setInterval(loadStats, 2000);
  }
}, { immediate: true });
watch(() => containers.value && Object.keys(containers.value).join(','), () => {
  void loadRowInfo();
});

onMounted(() => {
  ipcRenderer.on('settings-read', readSettings);
  ipcRenderer.on('settings-update', readSettings);
  ipcRenderer.on('images-process-output', onImageOutput);
  ipcRenderer.on('images-process-ended', onImageEnded);
  ipcRenderer.on('backend-locked', onBackendLocked);
  ipcRenderer.on('backend-unlocked', onBackendUnlocked);
  ipcRenderer.on('k8s-check-state' as any, onBackendState);
  ipcRenderer.on('extensions/changed', onBackendReady);
  ipcRenderer.send('settings-read');
  try {
    backendState.value = String(ipcRenderer.sendSync('k8s-state' as any) ?? '');
  } catch { /* shown as plain "Docker" */ }
  store.dispatch('credentials/fetchCredentials').catch(console.error);
  void connect();
  void loadUsage();
  void loadDiskUsed();
  usageTimer = setInterval(() => {
    // Containers stay null until a list succeeds; keep retrying until Docker answers.
    if (!containers.value) {
      void connect();
    } else {
      void loadVolumes();
    }
    void loadUsage();
    void loadDiskUsed();
  }, 5000);
  if (section.value === 'options') {
    void loadPreferences();
  }
});

onBeforeUnmount(() => {
  clearInterval(detailTimer);
  clearInterval(usageTimer);
  stopLogs();
  ipcRenderer.removeListener('settings-read', readSettings);
  ipcRenderer.removeListener('settings-update', readSettings);
  ipcRenderer.removeListener('images-process-output', onImageOutput);
  ipcRenderer.removeListener('images-process-ended', onImageEnded);
  ipcRenderer.removeListener('backend-locked', onBackendLocked);
  ipcRenderer.removeListener('backend-unlocked', onBackendUnlocked);
  ipcRenderer.removeListener('k8s-check-state' as any, onBackendState);
  ipcRenderer.removeListener('extensions/changed', onBackendReady);
  store.dispatch('container-engine/unsubscribe', 'sulla-docker');
  if (engine.held.value) {
    void engine.discardHeld();
  }
});
</script>

<template>
  <div class="sulla-docker">
    <div class="body">
      <!-- ── Sidebar ── -->
      <nav
        class="nav"
        aria-label="Docker"
      >
        <label class="search">
          <PrefIcon name="search" />
          <input
            v-model="query"
            type="search"
            placeholder="Search Docker"
            aria-label="Search Docker"
          >
        </label>
        <a
          v-for="item in NAV"
          :key="item.id"
          href="#"
          :class="{ on: navActive === item.id }"
          @click.prevent="go(item.id)"
        >
          <span class="sv"><PrefIcon :name="item.icon" /></span>{{ item.label }}
          <span
            v-if="item.count"
            class="cnt"
          >{{ navCounts[item.count] }}</span>
        </a>
        <div class="sep" />
        <a
          href="#"
          :class="{ on: navActive === 'snapshots' }"
          @click.prevent="go('snapshots')"
        ><span class="sv"><PrefIcon name="clock" /></span>Snapshots</a>
        <a
          href="#"
          :class="{ on: navActive === 'options' }"
          @click.prevent="go('options')"
        ><span class="sv"><PrefIcon name="sliders" /></span>Docker options</a>
        <div class="foot">
          <div class="engine">
            <div class="h">
              <span :class="engineDot" />{{ engineLabel }}
              <span class="r">
                <button
                  type="button"
                  title="Restart Docker"
                  @click="restartDocker"
                ><PrefIcon name="restart" /></button>
              </span>
            </div>
            <template
              v-for="m in meters"
              :key="m.label"
            >
              <div class="m">
                <span>{{ m.label }}</span><span><b>{{ m.value }}</b> {{ m.of }}</span>
              </div>
              <div class="bar">
                <i :style="{ width: m.width }" />
              </div>
            </template>
          </div>
          <a
            class="kline"
            href="#"
            @click.prevent="openKubernetesSettings"
          >
            <span class="sv"><PrefIcon name="helm" /></span>
            <span>Kubernetes <b>{{ kubernetesOn ? 'on' : 'off' }}</b></span>
            <span class="r">Settings</span>
          </a>
        </div>
      </nav>

      <main class="main">
        <div
          v-if="error"
          class="page errwrap"
        >
          <div class="alert">
            <PrefIcon name="alert" />
            <div class="x">
              <b>Docker couldn’t do that.</b><span>{{ error }}</span>
            </div>
            <div class="r">
              <button
                type="button"
                class="btn ghost"
                @click="error = ''"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>

        <!-- ── Containers ── -->
        <div
          v-if="section === 'containers'"
          class="page"
        >
          <div class="ph">
            <div>
              <h1>Containers</h1>
              <p>{{ runningCount }} running · {{ stoppedCount }} stopped</p>
            </div>
            <div class="r">
              <button
                type="button"
                class="btn"
                @click="go('add-image')"
              >
                <PrefIcon name="down" />Pull an image…
              </button>
            </div>
          </div>
          <section class="card">
            <div class="toolbar">
              <label class="search">
                <PrefIcon name="search" />
                <input
                  v-model="query"
                  type="search"
                  placeholder="Filter containers"
                >
              </label>
              <div class="ftabs">
                <a
                  href="#"
                  :class="{ on: containerFilter === 'all' }"
                  @click.prevent="containerFilter = 'all'"
                >All<span>{{ containerRows.length }}</span></a>
                <a
                  href="#"
                  :class="{ on: containerFilter === 'run' }"
                  @click.prevent="containerFilter = 'run'"
                >Running<span>{{ runningCount }}</span></a>
                <a
                  href="#"
                  :class="{ on: containerFilter === 'stop' }"
                  @click.prevent="containerFilter = 'stop'"
                >Stopped<span>{{ stoppedCount }}</span></a>
              </div>
            </div>
            <table class="tb">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Ports</th>
                  <th class="num">
                    CPU
                  </th>
                  <th class="num">
                    Memory
                  </th>
                  <th style="width:130px" />
                </tr>
              </thead>
              <tbody>
                <template
                  v-for="g in groups"
                  :key="g.name"
                >
                  <tr
                    class="grp"
                    @click="collapsed[g.name] = !collapsed[g.name]"
                  >
                    <td colspan="6">
                      <div class="gh">
                        <span
                          class="chev"
                          :class="{ shut: collapsed[g.name] }"
                        ><PrefIcon name="chevd" /></span>
                        <b>{{ displayProject(g.name) }}</b>
                        <small>{{ groupSubtitle(g.name, g.all[0]?.labels) }}</small>
                        <span
                          class="r"
                          @click.stop
                        >
                          <small>{{ g.running }} of {{ g.all.length }} running</small>
                          <template v-if="g.project">
                            <button
                              type="button"
                              class="btn sm ghost"
                              @click="groupStartOrStop(g)"
                            ><PrefIcon :name="g.running ? 'stop' : 'play'" />{{ g.running ? 'Stop' : 'Start' }}</button>
                            <button
                              type="button"
                              class="btn sm ghost"
                              @click="groupRestart(g)"
                            ><PrefIcon name="restart" />Restart</button>
                          </template>
                        </span>
                      </div>
                    </td>
                  </tr>
                  <template v-if="!collapsed[g.name]">
                    <tr
                      v-for="c in g.items"
                      :key="c.id"
                      class="row click child"
                      @click="openContainer(c)"
                    >
                      <td class="grow">
                        <div class="nm">
                          <span :class="dotClass(c)" />
                          <span><b>{{ cleanName(c.containerName) }}</b><small>{{ c.imageName }}</small></span>
                        </div>
                      </td>
                      <td>
                        <span
                          class="st"
                          :class="statusClass(c)"
                        >{{ statusText(c) }}</span>
                      </td>
                      <td
                        class="ports"
                        @click.stop
                      >
                        <template v-if="c.state === 'running' && uniquePorts(c).length">
                          <a
                            v-for="p in uniquePorts(c).slice(0, 2)"
                            :key="p.hostPort"
                            title="Open in Sulla browser"
                            @click="openPort(p)"
                          >localhost:{{ p.hostPort }}</a>
                          <span
                            v-if="uniquePorts(c).length > 2"
                            class="np"
                          >+{{ uniquePorts(c).length - 2 }}</span>
                        </template>
                        <span
                          v-else
                          class="np"
                        >—</span>
                      </td>
                      <td class="num">
                        {{ usageFor(c) ? `${usageFor(c).cpu.toFixed(1)}%` : '—' }}
                      </td>
                      <td class="num">
                        {{ usageFor(c) ? readableSize(usageFor(c).mem, true) : '—' }}
                      </td>
                      <td>
                        <div
                          class="acts"
                          @click.stop
                        >
                          <button
                            type="button"
                            :title="isUp(c) ? 'Stop' : 'Start'"
                            @click="startOrStop(c)"
                          >
                            <PrefIcon :name="isUp(c) ? 'stop' : 'play'" />
                          </button>
                          <button
                            type="button"
                            title="Restart"
                            @click="restart(c)"
                          >
                            <PrefIcon name="restart" />
                          </button>
                          <button
                            type="button"
                            title="Shell"
                            @click="openContainer(c, 'shell')"
                          >
                            <PrefIcon name="term" />
                          </button>
                          <button
                            type="button"
                            title="Delete"
                            @click="removeContainer(c)"
                          >
                            <PrefIcon name="trash" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  </template>
                </template>
                <tr v-if="!containers">
                  <td
                    colspan="6"
                    class="dimc"
                  >
                    Connecting to Docker…
                  </td>
                </tr>
                <tr v-else-if="!groups.length">
                  <td
                    colspan="6"
                    class="dimc"
                  >
                    No containers match.
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>

        <!-- ── Container detail ── -->
        <div
          v-else-if="section === 'container'"
          class="page"
        >
          <div class="crumb">
            <a
              href="#"
              @click.prevent="go('containers')"
            >Containers</a>
            <PrefIcon
              name="chev"
              class="cs"
            />
            <span>{{ selected ? displayProject(selected.projectGroup) : '' }}</span>
          </div>
          <section
            v-if="selected"
            class="card"
          >
            <div class="dhead">
              <span class="ic"><PrefIcon name="box" /></span>
              <div>
                <h1>{{ cleanName(selected.containerName) }}</h1>
                <div class="sub">
                  <span class="k"><span :class="dotClass(selected)" />{{ detailStatus }}</span>
                  <span class="mono">{{ selected.imageName }}</span>
                </div>
              </div>
              <div class="r">
                <button
                  v-if="selected.state === 'running' && selectedPorts.length"
                  type="button"
                  class="btn"
                  @click="openPort(selectedPorts[0])"
                >
                  <PrefIcon name="ext" />Open
                </button>
                <button
                  type="button"
                  class="btn"
                  @click="selected && startOrStop(selected)"
                >
                  <PrefIcon :name="isUp(selected) ? 'stop' : 'play'" />{{ isUp(selected) ? 'Stop' : 'Start' }}
                </button>
                <button
                  type="button"
                  class="btn"
                  @click="selected && restart(selected)"
                >
                  <PrefIcon name="restart" />Restart
                </button>
                <button
                  type="button"
                  class="btn ico danger"
                  title="Delete"
                  @click="selected && removeContainer(selected)"
                >
                  <PrefIcon name="trash" />
                </button>
              </div>
            </div>
            <div class="tabs">
              <a
                v-for="t in DETAIL_TABS"
                :key="t"
                href="#"
                :class="{ on: detailTab === t }"
                @click.prevent="setTab(t)"
              >{{ t[0].toUpperCase() + t.slice(1) }}</a>
            </div>

            <template v-if="detailTab === 'logs'">
              <div class="logbar">
                <label class="lsearch">
                  <PrefIcon name="search" />
                  <input
                    v-model="logQuery"
                    type="search"
                    placeholder="Search logs"
                  >
                </label>
                <button
                  type="button"
                  class="chk"
                  :class="{ on: logFollow }"
                  @click="logFollow = !logFollow"
                >
                  <i />Follow
                </button>
                <button
                  type="button"
                  class="chk"
                  :class="{ on: logTimestamps }"
                  @click="logTimestamps = !logTimestamps"
                >
                  <i />Timestamps
                </button>
                <select
                  v-model="logLevel"
                  class="sel"
                >
                  <option value="all">
                    All levels
                  </option>
                  <option value="warn">
                    Warnings and errors
                  </option>
                  <option value="error">
                    Errors
                  </option>
                </select>
                <span class="end">
                  <button
                    type="button"
                    class="btn sm"
                    @click="copy(logText())"
                  ><PrefIcon name="copy" />Copy</button>
                  <button
                    type="button"
                    class="btn sm"
                    @click="downloadLogs"
                  ><PrefIcon name="down" />Download</button>
                </span>
              </div>
              <div
                ref="logEl"
                class="term"
              >
                <div
                  v-for="(l, n) in shownLogs"
                  :key="n"
                >
                  <span
                    v-if="logTimestamps && l.ts"
                    class="ts"
                  >{{ `${l.ts}  ` }}</span><span :class="`lv-${l.level}`">{{ l.text }}</span>
                </div>
                <div
                  v-if="!shownLogs.length"
                  class="ts"
                >
                  {{ logLines.length ? 'No lines match.' : 'No logs yet.' }}
                </div>
              </div>
            </template>

            <DockerShell
              v-else-if="detailTab === 'shell'"
              :key="selected.id"
              :container-id="selected.id"
              :container-name="cleanName(selected.containerName)"
              :running="selected.state === 'running'"
              :namespace="namespace"
            />

            <table
              v-else-if="detailTab === 'ports'"
              class="tb"
            >
              <thead>
                <tr>
                  <th>On your Mac</th>
                  <th>In the container</th>
                  <th>Reachable from</th>
                  <th>Protocol</th>
                  <th style="width:160px" />
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="p in selectedPorts"
                  :key="`${p.hostIp}-${p.hostPort}-${p.containerPort}`"
                  class="row"
                >
                  <td class="ports">
                    <a @click="openPort(p)">localhost:{{ p.hostPort }}</a>
                  </td>
                  <td class="mono">
                    {{ p.containerPort }}
                  </td>
                  <td>
                    <span :class="{ warnc: isNetworkWide(p.hostIp) }">{{ reachableFrom(p.hostIp) }}</span>
                  </td>
                  <td>{{ p.protocol.toUpperCase() }}</td>
                  <td>
                    <div class="rowacts">
                      <button
                        type="button"
                        class="btn sm"
                        @click="openPort(p)"
                      >
                        <PrefIcon name="ext" />Open in Sulla
                      </button>
                      <button
                        type="button"
                        class="btn sm"
                        @click="copy(`localhost:${p.hostPort}`)"
                      >
                        <PrefIcon name="copy" />Copy
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="!selectedPorts.length">
                  <td
                    colspan="5"
                    class="dimc"
                  >
                    This container doesn’t publish any ports.
                  </td>
                </tr>
              </tbody>
            </table>

            <div
              v-else-if="detailTab === 'stats'"
              class="stats"
            >
              <p
                v-if="!isUp(selected)"
                class="dimc full"
              >
                Start this container to see live usage.
              </p>
              <div
                v-for="c in charts"
                :key="c.id"
                class="chart"
              >
                <div class="h">
                  <b>{{ c.title }}</b><span class="v">{{ c.value }}<small>{{ c.note }}</small></span>
                </div>
                <svg
                  :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
                  preserveAspectRatio="none"
                  @mousemove="onChartMove($event, c)"
                  @mouseleave="hover = null"
                >
                  <line
                    v-for="y in c.grid"
                    :key="y"
                    x1="0"
                    :x2="CHART_W"
                    :y1="y"
                    :y2="y"
                    stroke="var(--line)"
                    stroke-width="1"
                  />
                  <path
                    :d="c.area"
                    fill="var(--accent)"
                    opacity=".10"
                  />
                  <path
                    :d="c.line"
                    fill="none"
                    stroke="var(--accent)"
                    stroke-width="2"
                    vector-effect="non-scaling-stroke"
                    stroke-linejoin="round"
                  />
                  <line
                    v-if="hover?.id === c.id"
                    :x1="hover.x"
                    :x2="hover.x"
                    y1="0"
                    :y2="CHART_H"
                    stroke="var(--line-2)"
                    stroke-width="1"
                    vector-effect="non-scaling-stroke"
                  />
                </svg>
                <div class="ax">
                  <span>2 min ago</span><span>now</span>
                </div>
                <div
                  v-if="hover?.id === c.id"
                  class="tip"
                  :style="{ left: `${hover.left}px`, top: '44px' }"
                  v-html="hover.text"
                />
              </div>
            </div>

            <div
              v-else
              class="kv"
            >
              <template
                v-for="([k, v], n) in detailRows"
                :key="n"
              >
                <div class="k2">
                  {{ k }}
                </div>
                <div
                  class="v2"
                  :title="v"
                >
                  {{ v }}
                </div>
              </template>
            </div>
          </section>
          <section
            v-else
            class="card empty"
          >
            <h2>That container is gone</h2>
            <p>It may have been removed.</p>
            <div class="acts">
              <button
                type="button"
                class="btn"
                @click="go('containers')"
              >
                All containers
              </button>
            </div>
          </section>
        </div>

        <!-- ── Images ── -->
        <div
          v-else-if="section === 'images'"
          class="page"
        >
          <div class="ph">
            <div>
              <h1>Images</h1>
              <p>{{ imageRows.length }} images · {{ readableSize(imageRows.reduce((n, i) => n + i.size, 0)) }} · {{ readableSize(unusedImages.reduce((n, i) => n + i.size, 0)) }} not used by any container</p>
            </div>
            <div class="r">
              <button
                type="button"
                class="btn"
                :disabled="!unusedImages.length"
                @click="pruneImages"
              >
                Clean up unused…
              </button>
              <button
                type="button"
                class="btn pri"
                @click="go('add-image')"
              >
                <PrefIcon name="down" />Pull image
              </button>
            </div>
          </div>
          <section class="card">
            <div class="toolbar">
              <label class="search">
                <PrefIcon name="search" />
                <input
                  v-model="query"
                  type="search"
                  placeholder="Filter images"
                >
              </label>
              <div class="ftabs">
                <a
                  href="#"
                  :class="{ on: imageFilter === 'all' }"
                  @click.prevent="imageFilter = 'all'"
                >All<span>{{ imageRows.length }}</span></a>
                <a
                  href="#"
                  :class="{ on: imageFilter === 'used' }"
                  @click.prevent="imageFilter = 'used'"
                >In use<span>{{ imageRows.length - unusedImages.length }}</span></a>
                <a
                  href="#"
                  :class="{ on: imageFilter === 'unused' }"
                  @click.prevent="imageFilter = 'unused'"
                >Unused<span>{{ unusedImages.length }}</span></a>
              </div>
              <div class="r">
                <button
                  type="button"
                  class="btn sm ghost"
                  @click="go('add-image')"
                >
                  <PrefIcon name="plus" />Build from Dockerfile…
                </button>
              </div>
            </div>
            <table class="tb">
              <thead>
                <tr>
                  <th>Image</th>
                  <th>Tag</th>
                  <th class="num">
                    Size
                  </th>
                  <th>Used by</th>
                  <th>Created</th>
                  <th style="width:110px" />
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="i in shownImages"
                  :key="i.id"
                  class="row"
                >
                  <td class="grow">
                    <div class="nm">
                      <span
                        class="dot"
                        :class="{ off: !i.users.length }"
                      />
                      <b class="mono img">{{ i.repository }}</b>
                    </div>
                  </td>
                  <td class="mono">
                    {{ i.tag }}
                  </td>
                  <td class="num">
                    {{ readableSize(i.size) }}
                  </td>
                  <td :class="{ dimc: !i.users.length }">
                    {{ i.users.length ? usedBy(i.users) : 'Not used' }}
                  </td>
                  <td class="muted">
                    {{ ago(i.created) }}
                  </td>
                  <td>
                    <div class="acts">
                      <button
                        type="button"
                        title="Run"
                        @click="runImage(i.ref)"
                      >
                        <PrefIcon name="play" />
                      </button>
                      <button
                        type="button"
                        title="Delete"
                        @click="removeImage(i)"
                      >
                        <PrefIcon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="!shownImages.length">
                  <td
                    colspan="6"
                    class="dimc"
                  >
                    No images match.
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>

        <!-- ── Pull or build ── -->
        <div
          v-else-if="section === 'add-image'"
          class="page narrow"
        >
          <div class="crumb">
            <a
              href="#"
              @click.prevent="go('images')"
            >Images</a>
            <PrefIcon
              name="chev"
              class="cs"
            />
            <span>Pull or build</span>
          </div>
          <div class="ph">
            <div>
              <h1>Pull or build an image</h1>
              <p>Pull an image from a registry, or build one from a folder with a Dockerfile.</p>
            </div>
          </div>
          <section class="card">
            <div class="set">
              <div class="l">
                <b>Image</b><small>Like nginx:latest, or a name to tag a build with.</small>
              </div>
              <div class="c">
                <input
                  v-model="pullName"
                  class="inp"
                  placeholder="nginx:latest"
                  :disabled="pullBusy"
                  @keydown.enter="pullOrBuild('pull')"
                >
                <button
                  type="button"
                  class="btn pri"
                  :disabled="!pullName.trim() || pullBusy"
                  @click="pullOrBuild('pull')"
                >
                  <PrefIcon name="down" />Pull
                </button>
                <button
                  type="button"
                  class="btn"
                  :disabled="!pullName.trim() || pullBusy"
                  @click="pullOrBuild('build')"
                >
                  Build…
                </button>
              </div>
            </div>
            <div
              v-if="pullOutput"
              class="term out"
            >
              {{ pullOutput }}
            </div>
          </section>
        </div>

        <!-- ── Volumes ── -->
        <div
          v-else-if="section === 'volumes'"
          class="page"
        >
          <div class="ph">
            <div>
              <h1>Volumes</h1>
              <p>{{ volumeRows.length }} volumes{{ volumesTotal ? ` · ${readableSize(volumesTotal)}` : '' }}</p>
            </div>
            <div class="r">
              <button
                type="button"
                class="btn"
                @click="pruneVolumes"
              >
                Clean up unused…
              </button>
              <button
                type="button"
                class="btn pri"
                @click="ask = { kind: 'volume' }; askName = ''"
              >
                <PrefIcon name="plus" />New volume
              </button>
            </div>
          </div>
          <section class="card">
            <div class="toolbar">
              <label class="search">
                <PrefIcon name="search" />
                <input
                  v-model="query"
                  type="search"
                  placeholder="Filter volumes"
                >
              </label>
            </div>
            <table class="tb">
              <thead>
                <tr>
                  <th>Volume</th>
                  <th class="num">
                    Size
                  </th>
                  <th>Used by</th>
                  <th>Mounted at</th>
                  <th style="width:110px" />
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="v in namedVolumes"
                  :key="v.name"
                  class="row"
                >
                  <td class="grow">
                    <div class="nm">
                      <span
                        class="dot"
                        :class="{ off: !v.users.length }"
                      /><b>{{ v.name }}</b>
                    </div>
                  </td>
                  <td class="num">
                    {{ v.size === undefined ? '—' : readableSize(v.size) }}
                  </td>
                  <td :class="{ dimc: !v.users.length }">
                    {{ v.users.length ? v.users.join(', ') : 'Not used' }}
                  </td>
                  <td class="mono dimc">
                    {{ v.mount }}
                  </td>
                  <td>
                    <div class="acts">
                      <button
                        type="button"
                        title="Delete"
                        @click="removeVolumes([v.name], `Delete ${v.name}?`)"
                      >
                        <PrefIcon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
                <tr
                  v-if="looseVolumes.length"
                  class="row"
                >
                  <td colspan="5">
                    <div class="nm">
                      <span class="dot off" />
                      <span class="muted">{{ looseVolumes.length }} unnamed volumes{{ looseVolumes.some(v => v.size) ? ` · ${readableSize(looseVolumes.reduce((n, v) => n + (v.size ?? 0), 0))}` : '' }} · not used</span>
                      <span class="end">
                        <button
                          type="button"
                          class="btn sm"
                          @click="removeVolumes(looseVolumes.map(v => v.name), `Remove all ${looseVolumes.length} unnamed volumes?`)"
                        >Remove all {{ looseVolumes.length }}</button>
                      </span>
                    </div>
                  </td>
                </tr>
                <tr v-if="!namedVolumes.length && !looseVolumes.length">
                  <td
                    colspan="5"
                    class="dimc"
                  >
                    No volumes match.
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>

        <!-- ── Networks ── -->
        <div
          v-else-if="section === 'networks'"
          class="page"
        >
          <div class="ph">
            <div>
              <h1>Networks</h1>
              <p>{{ networkRows.length }} networks · {{ unusedNetworks }} not used</p>
            </div>
            <div class="r">
              <button
                type="button"
                class="btn"
                :disabled="!unusedNetworks"
                @click="pruneNetworks"
              >
                Clean up unused…
              </button>
              <button
                type="button"
                class="btn pri"
                @click="ask = { kind: 'network' }; askName = ''"
              >
                <PrefIcon name="plus" />New network
              </button>
            </div>
          </div>
          <section class="card">
            <table class="tb">
              <thead>
                <tr>
                  <th>Network</th>
                  <th>Driver</th>
                  <th>Subnet</th>
                  <th>Containers</th>
                  <th>From</th>
                  <th style="width:80px" />
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="n in shownNetworks"
                  :key="n.id"
                  class="row"
                >
                  <td><b>{{ n.name }}</b></td>
                  <td class="muted">
                    {{ n.driver }}
                  </td>
                  <td class="mono">
                    {{ n.subnet }}
                  </td>
                  <td :class="{ dimc: !n.count }">
                    {{ n.builtIn && !n.count ? '—' : n.count ? `${n.count} container${n.count === 1 ? '' : 's'}` : 'None running' }}
                  </td>
                  <td class="muted">
                    {{ n.from }}
                  </td>
                  <td>
                    <div
                      v-if="!n.builtIn"
                      class="acts"
                    >
                      <button
                        type="button"
                        title="Delete"
                        @click="removeNetwork(n.id, n.name)"
                      >
                        <PrefIcon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>

        <!-- ── Ports ── -->
        <div
          v-else-if="section === 'ports'"
          class="page"
        >
          <div class="ph">
            <div>
              <h1>Ports</h1>
              <p>Everything your containers make reachable on this Mac.</p>
            </div>
          </div>
          <section class="card">
            <div class="toolbar">
              <label class="search">
                <PrefIcon name="search" />
                <input
                  v-model="query"
                  type="search"
                  placeholder="Filter ports"
                >
              </label>
              <div class="ftabs">
                <a
                  href="#"
                  :class="{ on: portFilter === 'all' }"
                  @click.prevent="portFilter = 'all'"
                >All<span>{{ portRows.length }}</span></a>
                <a
                  href="#"
                  :class="{ on: portFilter === 'open' }"
                  @click.prevent="portFilter = 'open'"
                >Open to your network<span>{{ openPortCount }}</span></a>
              </div>
            </div>
            <table class="tb">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Goes to</th>
                  <th>From</th>
                  <th>Reachable from</th>
                  <th style="width:150px" />
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="r in shownPorts"
                  :key="`${r.c.id}-${r.port.hostIp}-${r.port.hostPort}`"
                  class="row"
                >
                  <td class="ports">
                    <a @click="openPort(r.port)">localhost:{{ r.port.hostPort }}</a>
                  </td>
                  <td class="mono muted">
                    {{ cleanName(r.c.containerName) }}:{{ r.port.containerPort }}
                  </td>
                  <td class="muted">
                    {{ displayProject(r.c.projectGroup) }}
                  </td>
                  <td>
                    <span
                      v-if="isNetworkWide(r.port.hostIp)"
                      class="k warnc"
                    ><span class="dot warn" />Your whole network</span>
                    <span
                      v-else
                      class="muted"
                    >This Mac only</span>
                  </td>
                  <td>
                    <div class="rowacts">
                      <button
                        type="button"
                        class="btn sm"
                        @click="openPort(r.port)"
                      >
                        <PrefIcon name="ext" />Open in Sulla
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="!shownPorts.length">
                  <td
                    colspan="5"
                    class="dimc"
                  >
                    No ports match.
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>

        <!-- ── Snapshots ── -->
        <div
          v-else-if="section === 'snapshots'"
          class="page narrow"
        >
          <div class="ph">
            <div>
              <h1>Snapshots</h1>
              <p>Save the whole Docker machine and roll back to it later.</p>
            </div>
            <div class="r">
              <button
                type="button"
                class="btn pri"
                @click="go('create-snapshot')"
              >
                <PrefIcon name="plus" />Take snapshot
              </button>
            </div>
          </div>
          <section class="card">
            <table class="tb">
              <thead>
                <tr>
                  <th>Snapshot</th>
                  <th>Taken</th>
                  <th style="width:170px" />
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="s in shownSnapshots"
                  :key="s.name"
                  class="row"
                >
                  <td>
                    <div class="nm">
                      <span class="sv"><PrefIcon name="clock" /></span>
                      <span><b>{{ s.name }}</b><small
                        v-if="s.description"
                        class="sans"
                      >{{ s.description }}</small></span>
                    </div>
                  </td>
                  <td class="muted">
                    {{ new Date(s.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }}
                  </td>
                  <td>
                    <div class="rowacts">
                      <button
                        type="button"
                        class="btn sm"
                        @click="restoreSnapshot(s.name)"
                      >
                        Restore…
                      </button>
                      <button
                        type="button"
                        class="btn sm ghost"
                        title="Delete"
                        @click="deleteSnapshot(s.name)"
                      >
                        <PrefIcon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="!shownSnapshots.length">
                  <td
                    colspan="3"
                    class="dimc"
                  >
                    No snapshots yet.
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>

        <!-- ── New snapshot ── -->
        <div
          v-else-if="section === 'create-snapshot'"
          class="page narrow"
        >
          <div class="crumb">
            <a
              href="#"
              @click.prevent="go('snapshots')"
            >Snapshots</a>
            <PrefIcon
              name="chev"
              class="cs"
            />
            <span>Take snapshot</span>
          </div>
          <div class="ph">
            <div>
              <h1>Take snapshot</h1>
              <p>Docker stops while the snapshot is taken, then starts again.</p>
            </div>
          </div>
          <section class="card">
            <div class="set">
              <div class="l">
                <b>Name</b>
              </div>
              <div class="c">
                <input
                  v-model="snapshotName"
                  class="inp"
                  placeholder="Before Kubernetes test"
                  :disabled="snapshotBusy"
                >
              </div>
            </div>
            <div class="set">
              <div class="l">
                <b>Description</b><small>Optional.</small>
              </div>
              <div class="c">
                <input
                  v-model="snapshotDescription"
                  class="inp"
                  :disabled="snapshotBusy"
                >
              </div>
            </div>
            <div class="set">
              <div class="l" />
              <div class="c">
                <button
                  type="button"
                  class="btn pri"
                  :disabled="!snapshotName.trim() || snapshotBusy"
                  @click="createSnapshot"
                >
                  {{ snapshotBusy ? 'Taking snapshot…' : 'Take snapshot' }}
                </button>
              </div>
            </div>
          </section>
        </div>

        <!-- ── Docker options: the same settings as Preferences › Docker ── -->
        <div
          v-else
          class="page narrow"
        >
          <DockerSection in-docker />
        </div>
      </main>
    </div>

    <div
      v-if="ask"
      class="scrim"
      @click.self="ask = null"
    >
      <div class="modal">
        <div class="mh">
          <h2>New {{ ask.kind }}</h2>
        </div>
        <div class="mb">
          <input
            v-model="askName"
            class="inp wide"
            :placeholder="ask.kind === 'volume' ? 'my_data' : 'my_network'"
            @keydown.enter="createFromAsk"
          >
        </div>
        <div class="mf">
          <div class="r">
            <button
              type="button"
              class="btn ghost"
              @click="ask = null"
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn pri"
              :disabled="!askName.trim()"
              @click="createFromAsk"
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="engine.held.value || engine.error.value"
      class="applybar"
      role="status"
    >
      <PrefIcon :name="engine.error.value ? 'alert' : 'restart'" />
      <span
        v-if="engine.error.value"
        class="msg badc"
      >{{ engine.error.value }}</span>
      <span
        v-else
        class="msg"
      >{{ engine.held.value === 'reset'
        ? 'These changes reset the virtual machine. Its data is deleted.'
        : 'These changes restart Docker. Running containers stop for a moment.' }}</span>
      <div class="r">
        <button
          v-if="engine.held.value"
          type="button"
          class="btn ghost"
          :disabled="engine.applying.value"
          @click="engine.discardHeld"
        >
          Discard
        </button>
        <button
          v-if="engine.held.value"
          type="button"
          class="btn pri"
          :disabled="engine.applying.value"
          @click="engine.applyHeld"
        >
          {{ engine.held.value === 'reset' ? 'Apply and reset' : 'Apply and restart' }}
        </button>
        <button
          v-else
          type="button"
          class="btn ghost"
          @click="engine.error.value = ''"
        >
          Dismiss
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="scss">
/*
 * Docker tab styles. Not scoped, so DockerSection and DockerShell share
 * them, but everything sits under .sulla-docker.
 */
@import '@pkg/assets/styles/sulla-window.scss';

.sulla-docker {
  @include sulla-window;

  /* ── Sidebar footer ── */
  .engine {
    padding: 11px 12px;
    border: 1px solid var(--line);
    border-radius: 11px;
    background: var(--card);
    font-size: 11.5px;
    color: var(--muted);
  }
  .engine .h {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 7px;
  }
  .engine .h .r {
    margin-left: auto;
    display: flex;
    gap: 2px;
  }
  .engine .h .r button {
    border: 0;
    background: transparent;
    color: var(--dim);
    padding: 3px;
    border-radius: 6px;
    display: grid;
  }
  .engine .h .r button:hover {
    background: var(--ink-05);
    color: var(--text);
  }
  .engine .h .r .pi {
    width: 14px;
    height: 14px;
  }
  .engine .m {
    display: flex;
    justify-content: space-between;
    margin-top: 5px;
  }
  .engine .m b {
    color: var(--text);
    font-weight: 600;
  }
  .kline .sv {
    display: grid;
    width: 15px;
    height: 15px;
  }
  .kline .sv .pi {
    width: 15px;
    height: 15px;
  }
  .dot.acc {
    background: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .errwrap { padding-bottom: 0; }
  .crumb {
    font-size: 12px;
    color: var(--dim);
    margin-bottom: 6px;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .crumb a { color: var(--accent-2); }
  .crumb .cs {
    width: 12px;
    height: 12px;
  }
  .btn .pi {
    width: 13px;
    height: 13px;
    flex: none;
  }
  .btn.ico .pi {
    width: 14px;
    height: 14px;
  }
  .sv {
    display: grid;
    width: 16px;
    height: 16px;
    color: var(--dim);
    flex: none;
  }
  .end {
    margin-left: auto;
    display: flex;
    gap: 6px;
  }
  .rowacts {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .inp.wide { width: 100%; }

  /* ── Tables ── */
  .tb {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
  }
  .tb th {
    text-align: left;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: .07em;
    text-transform: uppercase;
    color: var(--dim);
    padding: 9px 12px;
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  .tb td {
    padding: 9px 12px;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
    white-space: nowrap;
  }
  .tb tr:last-child td { border-bottom: 0; }
  .tb tr.row:hover td { background: color-mix(in srgb, var(--accent) 4.5%, transparent); }
  .tb tr.row.click { cursor: pointer; }
  .tb td.num, .tb th.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .tb td.mono, .tb .mono { font-size: 12px; }
  .tb td.grow {
    max-width: 1px;
    width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tb .nm {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .tb .nm > span:not(.dot) { min-width: 0; }
  .tb .nm b {
    font-weight: 600;
    display: block;
  }
  .tb .nm b.img {
    font-weight: 500;
    font-size: 12.5px;
  }
  .tb .nm small {
    display: block;
    color: var(--dim);
    font-size: 11.5px;
    font-family: var(--mono);
    max-width: 330px;
  }
  .tb .nm small.sans { font-family: var(--sans); }
  .tb .nm b, .tb .nm small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tb .acts {
    display: flex;
    justify-content: flex-end;
    gap: 2px;
    opacity: 0;
  }
  .tb tr.row:hover .acts { opacity: 1; }
  .tb .acts button {
    border: 0;
    background: transparent;
    color: var(--muted);
    width: 26px;
    height: 26px;
    border-radius: 7px;
    display: grid;
    place-items: center;
  }
  .tb .acts button:hover {
    background: var(--ink-08);
    color: var(--text);
  }
  .tb .acts .pi {
    width: 14px;
    height: 14px;
  }
  .tb tr.grp { cursor: pointer; }
  .tb tr.grp td {
    background: color-mix(in srgb, var(--paper-2) 60%, transparent);
    padding: 8px 12px;
    white-space: normal;
  }
  .tb tr.grp .gh {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .tb tr.grp .gh b { font-weight: 650; }
  .tb tr.grp .gh small {
    color: var(--dim);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .tb tr.grp .gh .r {
    margin-left: auto;
    display: flex;
    gap: 4px;
    align-items: center;
    cursor: default;
  }
  .tb tr.grp .gh .chev {
    width: 13px;
    height: 13px;
    color: var(--dim);
    transition: transform .15s;
  }
  .tb tr.grp .gh .chev.shut { transform: rotate(-90deg); }
  .tb tr.child td:first-child { padding-left: 34px; }
  .ports a {
    color: var(--accent-2);
    font-family: var(--mono);
    font-size: 12px;
    margin-right: 10px;
  }
  .ports a:hover { text-decoration: underline; }
  .ports .np { color: var(--dim); }
  .st {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
  }

  /* ── List toolbar ── */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
  }
  .toolbar .r {
    margin-left: auto;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .toolbar .search, .lsearch {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--line-2);
    border-radius: 8px;
    background: var(--card-solid);
    color: var(--dim);
    font-size: 12.5px;
    width: 280px;
  }
  .lsearch { width: 260px; }
  .toolbar .search:focus-within, .lsearch:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .toolbar .search .pi, .lsearch .pi {
    width: 14px;
    height: 14px;
    flex: none;
  }
  .toolbar .search input, .lsearch input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    padding: 0;
    height: auto;
    background: transparent !important;
    color: var(--text) !important;
    font-size: 12.5px;
  }
  .toolbar .search input::placeholder, .lsearch input::placeholder { color: var(--dim); }
  .ftabs {
    display: flex;
    gap: 16px;
    font-size: 12.5px;
  }
  .ftabs a {
    color: var(--muted);
    padding: 4px 0;
  }
  .ftabs a.on {
    color: var(--text);
    font-weight: 600;
    box-shadow: inset 0 -2px 0 var(--accent);
  }
  .ftabs a span {
    color: var(--dim);
    font-weight: 500;
    margin-left: 4px;
  }

  /* ── Container detail ── */
  .dhead {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 18px 20px;
  }
  .dhead .ic {
    width: 42px;
    height: 42px;
    border-radius: 11px;
    display: grid;
    place-items: center;
    background: var(--accent-soft);
    color: var(--accent-2);
    flex: none;
  }
  .dhead .ic .pi {
    width: 22px;
    height: 22px;
  }
  .dhead h1 {
    font-size: 20px;
    font-weight: 700;
  }
  .dhead .sub {
    display: flex;
    gap: 14px;
    align-items: center;
    color: var(--muted);
    font-size: 12.5px;
    margin-top: 3px;
    flex-wrap: wrap;
  }
  .dhead .r {
    margin-left: auto;
    display: flex;
    gap: 8px;
    flex: none;
  }
  .tabs {
    display: flex;
    gap: 22px;
    padding: 0 20px;
    border-top: 1px solid var(--line);
  }
  .tabs a {
    padding: 11px 0 10px;
    color: var(--muted);
    font-weight: 500;
  }
  .tabs a.on {
    color: var(--text);
    font-weight: 600;
    box-shadow: inset 0 -2px 0 var(--accent);
  }
  .term {
    background: #0b111c;
    color: #c9d4e3;
    font: 12px/1.65 var(--mono);
    padding: 14px 16px;
    border-radius: 0 0 var(--r) var(--r);
    height: 470px;
    overflow: auto;
    white-space: pre;
  }
  .term.out {
    height: auto;
    max-height: 360px;
    white-space: pre-wrap;
  }
  .term .ts { color: #66788f; }
  .term .lv-i { color: #6fb3d2; }
  .term .lv-w { color: #e3b341; }
  .term .lv-e { color: #f8716b; }
  .term .pr { color: #6fd39a; }
  .logbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 14px;
    border-top: 1px solid var(--line);
  }
  .chk {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 12.5px;
    color: var(--muted);
    border: 0;
    background: transparent;
    padding: 0;
  }
  .chk i {
    width: 15px;
    height: 15px;
    border-radius: 4px;
    border: 1.5px solid var(--line-2);
    display: grid;
    place-items: center;
  }
  .chk.on i {
    background: var(--accent);
    border-color: var(--accent);
  }
  .chk.on i::after {
    content: "";
    width: 7px;
    height: 4px;
    border-left: 2px solid #fff;
    border-bottom: 2px solid #fff;
    transform: rotate(-45deg) translate(1px, -1px);
  }
  .logbar .sel { min-width: 0; }
  .stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    padding: 16px;
  }
  .stats .full { grid-column: 1 / -1; }
  .chart {
    border: 1px solid var(--line);
    border-radius: 11px;
    padding: 12px 14px;
    background: var(--card-solid);
    position: relative;
  }
  .chart .h {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .chart .h b {
    font-size: 12.5px;
    font-weight: 600;
  }
  .chart .h .v {
    margin-left: auto;
    font-size: 18px;
    font-weight: 700;
  }
  .chart .h .v small {
    font-size: 11.5px;
    color: var(--dim);
    font-weight: 500;
    margin-left: 4px;
  }
  .chart svg {
    display: block;
    width: 100%;
    height: 110px;
    margin-top: 8px;
    overflow: visible;
  }
  .chart .ax {
    display: flex;
    justify-content: space-between;
    font-size: 10.5px;
    color: var(--dim);
    margin-top: 4px;
  }
  .tip {
    position: absolute;
    pointer-events: none;
    padding: 5px 8px;
    border-radius: 7px;
    background: var(--card-solid);
    border: 1px solid var(--line-2);
    box-shadow: var(--shadow-sm);
    font-size: 11.5px;
    white-space: nowrap;
    z-index: 5;
  }
  .tip b { font-weight: 650; }
  .kv {
    display: grid;
    grid-template-columns: 170px minmax(0, 1fr);
  }
  .kv > div {
    padding: 9px 18px;
    border-top: 1px solid var(--line);
    font-size: 12.5px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kv > div:nth-child(-n+2) { border-top: 0; }
  .kv .k2 { color: var(--dim); }
  .kv .v2 {
    font-family: var(--mono);
    font-size: 12px;
  }
  .empty {
    text-align: center;
    padding: 64px 24px 56px;
  }
  .empty h2 {
    font-family: var(--display);
    font-size: 26px;
    font-weight: 700;
  }
  .empty p {
    margin: 8px auto 0;
    max-width: 460px;
    color: var(--muted);
  }
  .empty .acts {
    margin-top: 20px;
    display: flex;
    justify-content: center;
    gap: 8px;
  }
  .scrim {
    position: absolute;
    inset: 0;
  }
  .applybar { transform: translateX(calc(-50% + 118px)); }
}
</style>
