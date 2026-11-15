#!/usr/bin/env python3
"""End-to-end Sulla Files torture test. Runs inside a Sulla VM.

Writes files through the real FUSE mount, keeps a checksum manifest outside Files
(SQLite under --state), then proves every file is listed, readable and intact.

  seed    --count N            write N new files (resumable; skips paths already in the manifest)
  verify  [--sample K]         read back files and compare sha256; compare each folder listing with the manifest
  churn   --ops N              random edits (new versions), deletes and renames, recorded in the manifest
  report                       print totals and the last run summaries as JSON

Nothing here prints file contents or secrets. Errors are counted by errno and kept as samples.
"""
import argparse, concurrent.futures as cf, errno, hashlib, json, os, random, sqlite3, sys, threading, time

MOUNT = os.environ.get('TORTURE_MOUNT', '/mnt/sulla-files')


def now():
    return time.time()


class Manifest:
    def __init__(self, state):
        os.makedirs(state, exist_ok=True)
        self.path = os.path.join(state, 'manifest.sqlite')
        self.lock = threading.Lock()
        self.db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=NORMAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, sha TEXT NOT NULL, size INTEGER NOT NULL, versions INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0, written_at REAL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY, mode TEXT, started REAL, finished REAL, summary TEXT)')

    def has(self, path):
        with self.lock:
            return self.db.execute('SELECT 1 FROM files WHERE path=?', (path,)).fetchone() is not None

    def put(self, path, sha, size, bump=False):
        with self.lock:
            if bump:
                self.db.execute('UPDATE files SET sha=?, size=?, versions=versions+1, written_at=? WHERE path=?', (sha, size, now(), path))
            else:
                self.db.execute('INSERT OR REPLACE INTO files(path, sha, size, versions, deleted, written_at) VALUES(?,?,?,1,0,?)', (path, sha, size, now()))

    def mark_deleted(self, path):
        with self.lock:
            self.db.execute('UPDATE files SET deleted=1 WHERE path=?', (path,))

    def rename(self, old, new):
        with self.lock:
            self.db.execute('UPDATE files SET path=? WHERE path=?', (new, old))

    def live(self, prefix):
        with self.lock:
            return self.db.execute('SELECT path, sha, size FROM files WHERE deleted=0 AND path LIKE ? ORDER BY path', (prefix + '%',)).fetchall()

    def count(self, prefix):
        with self.lock:
            return self.db.execute('SELECT COUNT(*) FROM files WHERE deleted=0 AND path LIKE ?', (prefix + '%',)).fetchone()[0]

    def run(self, mode, started, summary):
        with self.lock:
            self.db.execute('INSERT INTO runs(mode, started, finished, summary) VALUES(?,?,?,?)', (mode, started, now(), json.dumps(summary)))


class Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.ok = 0
        self.errors = {}
        self.samples = []
        self.lat = []

    def good(self, seconds):
        with self.lock:
            self.ok += 1
            if len(self.lat) < 200000:
                self.lat.append(seconds)

    def bad(self, kind, detail):
        with self.lock:
            self.errors[kind] = self.errors.get(kind, 0) + 1
            if len(self.samples) < 50:
                self.samples.append(f'{kind}: {detail}'[:300])

    def summary(self, elapsed):
        lat = sorted(self.lat)
        pct = lambda p: round(lat[min(len(lat) - 1, int(len(lat) * p))] * 1000, 1) if lat else None
        return {'ok': self.ok, 'errors': self.errors, 'error_samples': self.samples[:20], 'elapsed_s': round(elapsed, 1),
                'rate_per_s': round(self.ok / elapsed, 1) if elapsed else None, 'p50_ms': pct(0.5), 'p95_ms': pct(0.95), 'p99_ms': pct(0.99)}


def kind_of(exc):
    if isinstance(exc, OSError) and exc.errno is not None:
        return errno.errorcode.get(exc.errno, str(exc.errno))
    return type(exc).__name__


def tree_path(root, i, fanout, depth):
    # Spread files over a realistic tree: depth levels of `fanout` folders, ~fanout files per leaf.
    parts, n = [], i // fanout
    for _ in range(depth):
        parts.append(f'd{n % fanout:03d}')
        n //= fanout
    return f'{root}/' + '/'.join(reversed(parts)) + f'/f{i:08d}.txt'


def body(path, i, rng):
    filler = rng.randbytes(rng.randint(64, 2048)).hex()
    return f'sulla-files-torture\npath={path}\nindex={i}\n{filler}\n'.encode()


def write_file(rel, data):
    full = os.path.join(MOUNT, rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'wb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def cmd_seed(args, m):
    stats, started = Stats(), now()
    rng = random.Random(args.seed)
    start = m.count(args.root + '/')
    jobs = range(start, start + args.count)

    def one(i):
        rel = tree_path(args.root, i, args.fanout, args.depth)
        if m.has(rel):
            return
        data = body(rel, i, random.Random(args.seed * 1_000_003 + i))
        t = now()
        for attempt in range(3):
            try:
                write_file(rel, data)
                stats.good(now() - t)
                m.put(rel, hashlib.sha256(data).hexdigest(), len(data))
                return
            except Exception as exc:  # retry transient, but count every failure
                stats.bad(kind_of(exc), rel)
                time.sleep(0.5 * (attempt + 1))

    last = now()
    with cf.ThreadPoolExecutor(args.threads) as pool:
        for n, _ in enumerate(pool.map(one, jobs), 1):
            if now() - last > 30:
                last = now()
                print(json.dumps({'progress': n, 'of': args.count, **stats.summary(now() - started)}), flush=True)
    summary = {'root': args.root, 'requested': args.count, **stats.summary(now() - started)}
    m.run('seed', started, summary)
    print(json.dumps(summary), flush=True)


def cmd_verify(args, m):
    stats, started = Stats(), now()
    rows = m.live(args.root + '/')
    if args.sample and args.sample < len(rows):
        rows = random.Random(args.seed).sample(rows, args.sample)

    def one(row):
        rel, sha, size = row
        t = now()
        try:
            with open(os.path.join(MOUNT, rel), 'rb') as handle:
                data = handle.read()
            if len(data) != size or hashlib.sha256(data).hexdigest() != sha:
                stats.bad('CHECKSUM_MISMATCH', f'{rel} size={len(data)} expected={size}')
            else:
                stats.good(now() - t)
        except Exception as exc:
            stats.bad(kind_of(exc), rel)

    with cf.ThreadPoolExecutor(args.threads) as pool:
        list(pool.map(one, rows))

    # Listing check: every folder's directory listing must hold exactly the manifest's live children.
    expected = {}
    for rel, _, _ in m.live(args.root + '/'):
        folder, name = rel.rsplit('/', 1)
        expected.setdefault(folder, set()).add(name)
    folders = list(expected)
    if args.sample and args.sample < len(rows) + 1:
        folders = random.Random(args.seed).sample(folders, min(len(folders), max(50, args.sample // 100)))
    listing = {'folders_checked': 0, 'missing': 0, 'extra': 0, 'list_errors': 0, 'samples': []}
    lt = []
    for folder in folders:
        t = now()
        try:
            names = {entry.name for entry in os.scandir(os.path.join(MOUNT, folder)) if entry.is_file()}
        except Exception as exc:
            listing['list_errors'] += 1
            stats.bad('LIST_' + kind_of(exc), folder)
            continue
        lt.append(now() - t)
        listing['folders_checked'] += 1
        missing, extra = expected[folder] - names, names - expected[folder]
        listing['missing'] += len(missing)
        listing['extra'] += len(extra)
        if (missing or extra) and len(listing['samples']) < 10:
            listing['samples'].append({'folder': folder, 'missing': sorted(missing)[:5], 'extra': sorted(extra)[:5]})
    lt.sort()
    listing['list_p95_ms'] = round(lt[int(len(lt) * 0.95)] * 1000, 1) if lt else None
    summary = {'root': args.root, 'files_checked': len(rows), 'listing': listing, **stats.summary(now() - started)}
    m.run('verify', started, summary)
    print(json.dumps(summary), flush=True)


def cmd_churn(args, m):
    stats, started = Stats(), now()
    rng = random.Random(args.seed)
    rows = m.live(args.root + '/')
    for op in range(args.ops):
        if not rows:
            break
        idx = rng.randrange(len(rows))
        rel = rows[idx][0]
        action = rng.choices(['edit', 'delete', 'rename'], [0.7, 0.15, 0.15])[0]
        t = now()
        try:
            full = os.path.join(MOUNT, rel)
            if action == 'edit':
                data = body(rel, op, rng)
                write_file(rel, data)
                m.put(rel, hashlib.sha256(data).hexdigest(), len(data), bump=True)
            elif action == 'delete':
                os.remove(full)
                m.mark_deleted(rel)
                rows[idx] = rows[-1]; rows.pop()
            else:
                new = rel[:-4] + f'-r{op}.txt'
                os.rename(full, os.path.join(MOUNT, new))
                m.rename(rel, new)
                rows[idx] = (new,) + tuple(rows[idx][1:])
            stats.good(now() - t)
        except Exception as exc:
            stats.bad(f'{action.upper()}_' + kind_of(exc), rel)
    summary = {'root': args.root, 'ops': args.ops, **stats.summary(now() - started)}
    m.run('churn', started, summary)
    print(json.dumps(summary), flush=True)


def cmd_report(args, m):
    runs = m.db.execute('SELECT mode, started, finished, summary FROM runs ORDER BY id DESC LIMIT 20').fetchall()
    print(json.dumps({'live_files': m.count(args.root + '/'), 'runs': [{'mode': r[0], 'started': r[1], 'finished': r[2], **json.loads(r[3])} for r in runs]}, indent=1))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('mode', choices=['seed', 'verify', 'churn', 'report'])
    p.add_argument('--root', default='Stress/torture')
    p.add_argument('--state', default='/mnt/data/files-torture')
    p.add_argument('--count', type=int, default=1000)
    p.add_argument('--ops', type=int, default=1000)
    p.add_argument('--sample', type=int, default=0)
    p.add_argument('--threads', type=int, default=16)
    p.add_argument('--fanout', type=int, default=100)
    p.add_argument('--depth', type=int, default=2)
    p.add_argument('--seed', type=int, default=20261115)
    args = p.parse_args()
    if not os.environ.get('TORTURE_MOUNT') and not os.path.ismount(MOUNT):
        sys.exit(f'{MOUNT} is not mounted')
    m = Manifest(args.state)
    {'seed': cmd_seed, 'verify': cmd_verify, 'churn': cmd_churn, 'report': cmd_report}[args.mode](args, m)


if __name__ == '__main__':
    main()
