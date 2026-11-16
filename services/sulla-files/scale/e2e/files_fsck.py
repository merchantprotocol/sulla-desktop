#!/usr/bin/env python3
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.
"""Files integrity checker (fsck). Run inside the Sulla VM; needs only python3 and docker.

    python3 files_fsck.py                          # read-only metadata + chunk-store check of every live file
    python3 files_fsck.py --deep                   # also parse every encrypted blob's envelope
    python3 files_fsck.py --deep --mount /mnt/sulla-files   # also read every file back through the mount
    python3 files_fsck.py --recheck-mount /mnt/sulla-files --out fsck.jsonl   # re-read only the files listed as problems
    python3 files_fsck.py --repair                 # opt-in: lossless repairs only (re-register chunk rows)
    python3 files_fsck.py --repair --rollback-unrecoverable   # opt-in: also restore newest readable version

Output: JSONL (one `problem` record per broken file: fileId, path, versionId, failureClass, problems;
`repair` records; one `summary`), written to stdout and to --out. Exit code 0 = clean, 1 = problems, 2 = error.
The checker itself is files_fsck.mjs, executed inside the sulla_files container with the service's own
`pg` module and chunk volume; nothing is installed. It never prints file content or keys.
"""
import argparse, json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))


class MountReader:
    """Reads a file back through the Files mount: proves decrypt + chunk identity end to end."""

    def __init__(self, root):
        self.root = root

    def candidates(self, record):
        path = record.get('path') or ''
        explorer = record.get('explorerPath') or ''
        out = [os.path.join(self.root, explorer, path)] if explorer else []
        out.append(os.path.join(self.root, path))
        return out

    def check(self, record):
        for candidate in self.candidates(record):
            if not os.path.lexists(candidate):
                continue
            total = 0
            try:
                with open(candidate, 'rb') as handle:
                    while True:
                        block = handle.read(1 << 20)
                        if not block:
                            break
                        total += len(block)
            except OSError as error:
                return {'mountRead': 'failed', 'errno': error.errno, 'mountPath': candidate}
            expected = record.get('size')
            if expected is not None and total != expected:
                return {'mountRead': 'size_mismatch', 'bytes': total, 'expected': expected, 'mountPath': candidate}
            return {'mountRead': 'ok', 'bytes': total, 'mountPath': candidate}
        return {'mountRead': 'unmapped'}


class FsckRunner:
    def __init__(self, args):
        self.args = args
        self.out = open(args.out, 'a', encoding='utf-8') if args.out else None

    def emit(self, record):
        line = json.dumps(record, sort_keys=True)
        print(line, flush=True)
        if self.out:
            self.out.write(line + '\n')
            self.out.flush()

    def options(self):
        return {
            'deep': self.args.deep, 'repair': self.args.repair, 'rollbackUnrecoverable': self.args.rollback_unrecoverable,
            'strict': self.args.strict, 'pageSize': self.args.page_size, 'limit': self.args.limit,
            'collectionId': self.args.collection, 'progress': not self.args.quiet,
        }

    def command(self):
        return ['docker', 'exec', '-i', '-w', '/app/services/sulla-files', '-e', 'FSCK_OPTS=' + json.dumps(self.options()),
                self.args.container, 'node', '--input-type=module', '-']

    def run(self):
        if self.args.rollback_unrecoverable and not self.args.repair:
            sys.exit('--rollback-unrecoverable requires --repair')
        if self.args.repair and not self.args.yes:
            sys.stderr.write('--repair writes to the Files database (adds chunk rows / restore versions, deletes nothing). Re-run with --yes to confirm.\n')
            sys.exit(2)
        with open(os.path.join(HERE, 'files_fsck.mjs'), 'rb') as handle:
            script = handle.read()
        mount = MountReader(self.args.mount) if self.args.mount else None
        process = subprocess.Popen(self.command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr)
        process.stdin.write(script)
        process.stdin.close()
        problems, failed, summary = 0, False, None
        for raw in process.stdout:
            try:
                record = json.loads(raw)
            except ValueError:
                sys.stderr.write(raw.decode('utf-8', 'replace'))
                continue
            kind = record.get('type')
            if kind == 'progress' and self.args.quiet:
                continue
            if kind == 'problem':
                problems += 1
                if mount:
                    record.update(mount.check(record))
            if kind == 'error':
                failed = True
            if kind == 'summary':
                summary = record
                if mount:
                    summary = self.mount_sweep(mount, summary)
                record = summary
            self.emit(record)
        code = process.wait()
        if failed or code != 0 or summary is None:
            return 2
        return 1 if problems or summary.get('mountFailures') else 0

    def mount_sweep(self, mount, summary):
        """With --deep and --mount, read every live file back through the mount, not only problem files."""
        if not self.args.deep:
            return summary
        failures = 0
        for dirpath, _dirs, files in os.walk(self.args.mount):
            for name in files:
                path = os.path.join(dirpath, name)
                try:
                    with open(path, 'rb') as handle:
                        while handle.read(1 << 20):
                            pass
                except OSError as error:
                    failures += 1
                    self.emit({'type': 'problem', 'failureClass': 'mount_read_failed', 'mountPath': path, 'errno': error.errno})
        summary = dict(summary)
        summary['mountFailures'] = failures
        return summary


def recheck(args):
    """Re-reads only the files listed as problems in an earlier --out file (e.g. after --repair)."""
    mount = MountReader(args.recheck_mount)
    ok = bad = 0
    with open(args.out, encoding='utf-8') as handle:
        for line in handle:
            record = json.loads(line)
            if record.get('type') != 'problem' or not record.get('fileId'):
                continue
            result = mount.check(record)
            ok += result['mountRead'] == 'ok'
            bad += result['mountRead'] != 'ok'
            print(json.dumps({'type': 'recheck', 'fileId': record['fileId'], 'path': record.get('path'), **result}, sort_keys=True))
    print(json.dumps({'type': 'recheck-summary', 'ok': ok, 'notOk': bad}))
    return 0 if bad == 0 else 1


def main():
    parser = argparse.ArgumentParser(description='Sulla Files integrity checker (read-only unless --repair)')
    parser.add_argument('--container', default=os.environ.get('SULLA_FILES_CONTAINER', 'sulla_files'))
    parser.add_argument('--deep', action='store_true', help='parse every encrypted blob envelope (reads every chunk once)')
    parser.add_argument('--mount', help='Files mount root (e.g. /mnt/sulla-files): read problem files back; with --deep, read every file')
    parser.add_argument('--recheck-mount', help='only re-read the problem files listed in --out through this mount')
    parser.add_argument('--strict', action='store_true', help='also report chunks evicted from the local cache (cloud installs)')
    parser.add_argument('--collection', help='limit to one collection id')
    parser.add_argument('--page-size', type=int, default=1000)
    parser.add_argument('--limit', type=int, default=0, help='stop after about this many files (0 = all)')
    parser.add_argument('--out', default='files-fsck-%s.jsonl' % time.strftime('%Y%m%d-%H%M%S'))
    parser.add_argument('--quiet', action='store_true', help='no progress records')
    parser.add_argument('--repair', action='store_true', help='opt-in repair (never deletes)')
    parser.add_argument('--rollback-unrecoverable', action='store_true', help='with --repair: restore the newest readable version of unrecoverable files')
    parser.add_argument('--yes', action='store_true', help='confirm --repair')
    args = parser.parse_args()
    if args.recheck_mount:
        sys.exit(recheck(args))
    sys.exit(FsckRunner(args).run())


if __name__ == '__main__':
    main()
