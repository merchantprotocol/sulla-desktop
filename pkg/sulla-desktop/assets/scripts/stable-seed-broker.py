# SPDX-License-Identifier: GPL-2.0-or-later
"""Guest-side path broker. Only the confined helper interprets Git configuration."""
import contextlib
import ctypes
import fcntl
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path


def require(ok, message):
    if not ok:
        raise ValueError(message)


class Handles(contextlib.ExitStack):
    """Walk every component with O_NOFOLLOW; inspect type before opening for I/O."""
    def pin(self, path, parent=None, kind=stat.S_ISDIR):
        path = Path(path)
        if parent is None:
            require(path.is_absolute(), 'absolute seed path required')
            parent = self.keep(os.open('/', os.O_RDONLY | os.O_DIRECTORY))
        parts = path.parts[1:] if path.is_absolute() else path.parts
        for i, name in enumerate(parts):
            require(name not in ('.', '..'), 'invalid path component')
            fd = self.keep(os.open(name, os.O_PATH | os.O_NOFOLLOW, dir_fd=parent))
            mode = os.fstat(fd).st_mode
            require((kind if i == len(parts)-1 else stat.S_ISDIR)(mode), 'invalid seed path type')
            parent = fd
        return parent

    def keep(self, fd):
        self.callback(os.close, fd)
        return fd

    @staticmethod
    def proc(fd):
        return f'/proc/{os.getpid()}/fd/{fd}'

    def text(self, fd):
        with open(self.proc(fd), 'rb') as f:
            data = f.read(8193)
        require(len(data) <= 8192, 'oversized seed pointer')
        return data.decode().removesuffix('\n')

    def optional(self, path, parent):
        try:
            return self.pin(path, parent, stat.S_ISREG)
        except FileNotFoundError:
            return None


class MountPins:
    """Docker receives only stable, broker-owned names, never a worker pathname."""
    def __init__(self, private, handles):
        self.private, self.handles = private, handles

    def view(self, fd):
        return self.handles.pin(self.bind(fd))  # pinned, nonrecursive mount under the private run directory

    def bind(self, fd):
        is_dir = stat.S_ISDIR(os.fstat(fd).st_mode)
        if is_dir:
            dest = tempfile.mkdtemp(prefix='pin-', dir=self.private)
        else:
            leaf, dest = tempfile.mkstemp(prefix='pin-', dir=self.private)
            os.close(leaf)
        libc = ctypes.CDLL(None, use_errno=True)
        src, dst = os.fsencode(self.handles.proc(fd)), os.fsencode(dest)
        # Nonrecursive MS_BIND: do not project any subordinate host mounts.
        if libc.mount(src, dst, None, 4096, None):
            error = ctypes.get_errno()
            (os.rmdir if is_dir else os.unlink)(dest)
            raise OSError(error, 'cannot pin seed mount')
        return dest

    @staticmethod
    def detach(dest):
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.umount2(os.fsencode(dest), 2 | 8):  # MNT_DETACH | UMOUNT_NOFOLLOW
            raise OSError(ctypes.get_errno(), 'cannot release seed mount')


class RunLedger:
    # The 0700 directory name IS the record: a single mkdir registers the run
    # before any mount, stage, or helper can exist. Only the broker can rename it.
    def __init__(self, home, mounts):
        self.home, self.mounts = home, mounts

    def start(self):
        run = self.home / ('run-' + uuid.uuid4().hex)
        run.mkdir(mode=0o700)
        return run

    def recover(self):
        for name in os.listdir(self.home):
            if re.fullmatch(r'run-[0-9a-f]{32}', name):
                self.release(self.home / name)

    @staticmethod
    def mountpoints(run):
        # mountinfo escapes spaces, tabs, newlines and backslashes in field 5.
        # Compare lexical components, never resolve a path through a mounted source.
        result = []
        with open('/proc/self/mountinfo', 'rb') as table:
            for line in table:
                raw = line.split(b' ')[4]
                path = Path(os.fsdecode(re.sub(rb'\\(040|011|012|134)',
                            lambda m: bytes([int(m[1], 8)]), raw)))
                if path.is_relative_to(run):
                    result.append(path)
        return result

    def release(self, run):
        require(run not in self.mountpoints(run), 'refusing mounted seed run directory')
        info = run.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and
                stat.S_IMODE(info.st_mode) == 0o700, 'unsafe seed run directory')
        ContainerRunner.stop_helpers(run.name)
        # Only detach our direct pin leaves. A lazy unmount detaches the entire
        # mount subtree without entering it. Never descend to unmount a child.
        points = self.mountpoints(run)
        while points:
            leaf = next((p for p in points if p.parent == run and p.name.startswith('pin-')), None)
            require(leaf is not None, 'unexpected mount under seed run')
            self.mounts.detach(leaf)
            remaining = self.mountpoints(run)
            require(len(remaining) < len(points), 'seed mount still attached')
            points = remaining
        # Exclusive broker lock, no remaining helper, no mounts, private parent.
        # Use the fd-based deletion implementation; never follow stage symlinks.
        require(shutil.rmtree.avoids_symlink_attacks, 'unsafe seed cleanup unavailable')
        shutil.rmtree(run)


class ContainerRunner:
    LABEL = 'com.sulla.stable-seed.run'

    def __init__(self, image, uid, gid, helper, run_id):
        self.image, self.uid, self.gid, self.helper = image, uid, gid, helper
        self.run_id = run_id

    @staticmethod
    def docker(*args, check=True):
        return subprocess.run(['/usr/bin/docker', *args], check=check, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, cwd='/', env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'})

    @classmethod
    def stop_helpers(cls, run_id):
        def active():
            return cls.docker('ps', '-aq', '--no-trunc', '--filter', f'label={cls.LABEL}={run_id}').stdout.split()
        ids = active()
        for ident in ids:
            require(re.fullmatch(b'[0-9a-f]{64}', ident), 'invalid seed helper ID')
            cls.docker('rm', '-f', ident, check=False)  # --rm can race with this removal.
        require(not ids or not active(), 'seed helper still active')

    def resolve_image(self):
        # An image VOLUME silently adds writable mounts. Pin the checked local ID
        # once so producer and publisher cannot select different image generations.
        result = self.docker('image', 'inspect', '--format', '{{.Id}} {{json .Config.Volumes}}', self.image)
        image, volumes = result.stdout.decode().strip().split(' ', 1)
        require(re.fullmatch('sha256:[0-9a-f]{64}', image) and not json.loads(volumes),
                'unsupported seed image or implicit volumes')
        self.image = image

    def run(self, mounts, operation, paths, *args, output=None, limit=32768):
        cmd = ['/usr/bin/docker', 'run', '--rm', '--label', f'{self.LABEL}={self.run_id}', '--pull=never', '--user', f'{self.uid}:{self.gid}',
               '--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
               '--pids-limit=64', '--memory=512m', '--memory-swap=512m', '--ipc=none', '--log-driver=none', '--workdir=/',
               '--tmpfs', '/tmp:rw,nodev,nosuid,noexec,size=256m,mode=1777', '--entrypoint=/usr/bin/env']
        for src, dest, writable in mounts:
            cmd += ['--mount', f'type=bind,src={src},dst={dest},bind-recursive=disabled' +
                    ('' if writable else ',readonly')]
        cmd += [self.image, '-i', 'PATH=/usr/bin:/bin', '/usr/bin/python3', '-IS', '-c', self.helper,
                str(self.uid), str(self.gid), operation, json.dumps(paths), *args]
        with subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, cwd='/', env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'}) as proc:
            try:
                if output is None:
                    result = proc.stdout.read(limit + 1)
                    require(len(result) <= limit, 'oversized helper response')
                else:
                    total = 0
                    while chunk := proc.stdout.read(65536):
                        total += len(chunk)
                        require(total <= limit, 'no space left on device for seed bundle and VM reserve')
                        output.write(chunk)
                    result = None
                code = proc.wait()
                require(code != 79, 'no space left on device for expanded checkout and VM reserve')
                require(code == 0, 'confined seed ' + operation + ' failed')
                return result
            finally:
                if proc.poll() is None:
                    proc.kill()


class Checkout:
    def __init__(self, path, directory, h, pins, private, allow_link, module=None):
        self.pins, self.private = pins, private
        dot = h.pin('.git', directory, lambda m: stat.S_ISDIR(m) or stat.S_ISREG(m))
        self.linked = stat.S_ISREG(os.fstat(dot).st_mode)
        if self.linked and module:
            admin_path, admin = module.pin_admin(path, h.text(dot))
            common = admin
        elif self.linked:
            require(allow_link, 'linked recovery target refused')
            pointer = h.text(dot)
            require(pointer.startswith('gitdir: '), 'invalid worktree pointer')
            admin_path = Path(os.path.normpath(os.path.join(path, pointer[8:])))
            require(admin_path.parent.name == 'worktrees' and admin_path.parent.parent.name == '.git',
                    'invalid worktree administration directory')
            common = h.pin(admin_path.parent.parent)
            admin = h.pin(Path('worktrees', admin_path.name), common)
            require(h.text(h.pin('commondir', admin, stat.S_ISREG)) == '../..', 'invalid common directory')
            back = os.path.normpath(os.path.join(admin_path, h.text(h.pin('gitdir', admin, stat.S_ISREG))))
            require(back == str(path / '.git') and os.path.samestat(os.fstat(dot),
                    os.fstat(h.pin(back, kind=stat.S_ISREG))), 'unregistered worktree')
            self.name = admin_path.parent.parent.parent.name
        else:
            common = admin = dot
            self.name = path.name
        self.directory, self.common, self.admin = directory, common, (admin_path if self.linked else path / '.git', admin)
        head = h.pin('HEAD', admin, stat.S_ISREG)
        tip = h.text(head)
        self.ref = tip[5:] if tip.startswith('ref: ') else 'HEAD'
        require(self.ref == 'HEAD' or (self.ref.startswith('refs/heads/') and
                all(part and part not in ('.', '..') for part in self.ref.split('/')) and
                not any(ord(c) < 32 for c in self.ref)), 'unsupported seed ref')
        self.files = {'objects': h.pin('objects', common), 'config': h.pin('config', common, stat.S_ISREG),
                      'packed': h.optional('packed-refs', common), 'index': h.optional('index', admin),
                      'tip': head if self.ref == 'HEAD' else h.optional(self.ref, common)}
        if self.ref != 'HEAD':
            self.files['tracking'] = h.optional('refs/remotes/origin/' + self.ref[11:], common)
        # Never permit worker-provided alternates, grafts or replacement refs.
        h.pin('info', self.files['objects'])
        self.mask = Path(private, 'mask-dir')
        self.mask.mkdir(exist_ok=True)
        self.mounts, self.paths = [], {'checkout': '/seed/checkout'}
        for key, fd in self.files.items():
            if fd is not None:
                self.paths[key] = '/seed/' + key
                self.mounts.append((pins.bind(fd), self.paths[key], False))
        self.mounts.append((str(self.mask), '/seed/objects/info', False))

    def read(self, runner, op, expected='', **kwargs):
        mounts = list(self.mounts)
        if op in ('bundle', 'size', 'clean'):
            mask = self.mask
            if self.linked:
                mask = Path(self.private, 'mask-file')
                mask.touch(exist_ok=True)
            mounts += [(self.pins.bind(self.directory), self.paths['checkout'], False),
                       (str(mask), self.paths['checkout'] + '/.git', False)]
        return runner.run(mounts, op, self.paths, self.ref, expected, **kwargs)


class StableSeed:
    def __init__(self, runner, handles, private, reserve, mounts):
        self.runner, self.h, self.private, self.reserve, self.pins = runner, handles, private, reserve, mounts

    def checkout(self, path, directory, allow_link=False):
        return Checkout(path, directory, self.h, self.pins, self.private, allow_link)

    def free(self):
        data = subprocess.check_output(['/bin/df', '-Pk', self.private]).splitlines()
        return int(data[-1].split()[3])

    def reopen(self, target, directory, source, key):
        entries = os.listdir(self.h.proc(directory))
        if not entries:
            return False
        require('.git' in entries, 'refusing an unbound non-Git stable workspace')
        repo = self.checkout(target, directory)
        marker = self.h.optional('sulla-workspace-binding', repo.common)
        if marker is not None:
            require(self.h.text(marker).split('\n')[0] == str(source), 'stable workspace belongs to another seed')
        else:
            require(key, 'refusing to replace a nonempty unbound stable workspace')
        repo.read(self.runner, 'reopen')
        return True

    def retained(self, repo, metadata, key, legacy):
        if not key:
            return
        try:
            agents = self.h.pin(legacy)
        except FileNotFoundError:
            return
        ref, head, origin, _ = metadata
        branch = 'detached-' + head[:12] if ref == 'HEAD' else ref[11:]
        prefix = re.sub(rb'[^A-Za-z0-9_.-]', b'-', f'{repo.name}-{branch}-{key}-'.encode()).decode('ascii')
        candidates = [n for n in os.listdir(self.h.proc(agents)) if n.startswith(prefix[:80]) and len(n) == len(prefix[:80]) + 8]
        if not candidates:
            return
        message = 'could not identify a single safe retained checkout for the interrupted task'
        require(len(candidates) == 1 and len(prefix) <= 80 and re.fullmatch('[A-Za-z0-9]{8}', candidates[0][-8:]), message)
        path = legacy / candidates[0]
        existing = self.checkout(path, self.h.pin(candidates[0], agents))
        stored = json.loads(existing.read(self.runner, 'legacy', head))[2]
        require(os.path.samestat(os.fstat(existing.directory), os.fstat(self.h.pin(path))), message)
        require(stored == origin or (not origin and re.fullmatch(re.escape(str(path)) +
                r'\.bundle-[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}', stored)), message)
        return path

    def handoff(self, stage, parent, target, directory):
        # Linux renameat checks emptiness atomically, but has no compare-inode option.
        # Protect this *pinned immediate parent* while checking the target identity.
        pfd = self.h.keep(os.open(self.h.proc(parent), os.O_RDONLY | os.O_DIRECTORY))
        info = os.fstat(pfd)
        require(info.st_uid in (os.geteuid(), self.runner.uid) and not info.st_mode & 0o7000,
                'unsafe conversation parent permissions')
        os.fchown(pfd, os.geteuid(), -1)
        try:
            require(not os.fstat(pfd).st_mode & 0o022, 'writable conversation parent')
            require(os.path.samestat(os.fstat(pfd), os.fstat(self.h.pin(target.parent))) and
                    os.path.samestat(os.fstat(directory), os.stat(target.name, dir_fd=pfd, follow_symlinks=False)),
                    'stable publication target changed')
            ready = self.h.pin(stage)
            os.replace(stage, target.name, dst_dir_fd=pfd)
            require(os.path.samestat(os.fstat(ready), os.fstat(self.h.pin(target))),
                    'stable publication parent changed')
        finally:
            os.fchown(pfd, info.st_uid, -1)

    def seed(self, source, target, key, legacy):
        h = self.h
        parent = h.pin(target.parent)
        directory = h.pin(target.name, parent)
        if self.reopen(target, directory, source, key):
            require(os.path.samestat(os.fstat(directory), os.fstat(h.pin(target))), 'reopen target changed')
            return target
        repo = self.checkout(source, h.pin(source), allow_link=True)
        metadata, links = json.loads(repo.read(self.runner, 'inspect'))
        previous = self.retained(repo, metadata, key, legacy)
        if previous:
            return previous
        GitlinkProbe(self).check(repo, source, links)
        usage = int(repo.read(self.runner, 'size'))
        budget = min(8 * 1024**3, (self.free() - self.reserve - usage) * 512)
        require(budget > 0, 'no space left on device for workspace and VM reserve')
        approved = json.dumps(metadata)
        with tempfile.NamedTemporaryFile(dir=self.private) as bundle:
            repo.read(self.runner, 'bundle', approved, output=bundle, limit=budget)
            bundle.flush()
            os.fchmod(bundle.fileno(), 0o444)
            require(self.free() - usage >= self.reserve, 'no space left on device for checkout and VM reserve')
            stage = tempfile.mkdtemp(dir=self.private)
            os.chown(stage, self.runner.uid, self.runner.gid)
            self.runner.run([(bundle.name, '/seed/input', False), (stage, '/seed/stage', True)],
                            'publish', {'bundle': '/seed/input', 'stage': '/seed/stage'}, approved, str(source), str(self.reserve))
            require(self.free() >= self.reserve, 'no space left on device for workspace and VM reserve')
            self.handoff(stage, parent, target, directory)
        return target


def main(mounts):
    src, dst, conversations, agents, private, uid, gid, image, reserve, key, helper = sys.argv[1:]
    src, dst = Path(src), Path(dst)
    require(dst.name == 'workspace' and dst.parent.parent == Path(conversations) and
            re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*', dst.parent.name), 'invalid conversation workspace')
    require(src.is_relative_to('/mnt/worktrees') and src != Path('/mnt/worktrees'), 'invalid checkout')
    require(int(uid) > 0 and int(gid) > 0, 'invalid seed identity')
    with Handles() as h:
        home = Path(private)
        owner = os.fstat(h.pin(home.parent))
        require(owner.st_uid == os.geteuid() and not owner.st_mode & 0o022, 'unsafe seed broker parent')
        home.mkdir(mode=0o700, exist_ok=True)
        root = h.pin(home)
        info = os.fstat(root)
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700, 'unsafe seed broker directory')
        lock = h.keep(os.open(h.proc(root), os.O_RDONLY | os.O_DIRECTORY))
        fcntl.flock(lock, fcntl.LOCK_EX)
        ledger = RunLedger(home, mounts)
        ledger.recover()  # A disconnected guest exec receives SIGKILL; finally is not guaranteed.
        require(os.fstat(h.pin(dst)).st_dev == info.st_dev, 'workspace and private staging must share a filesystem')
        work = ledger.start()
        try:
            runner = ContainerRunner(image, int(uid), int(gid), helper, work.name)
            runner.resolve_image()
            with Handles() as pins:
                seed = StableSeed(runner, pins, work, int(reserve), mounts(work, pins))
                result = seed.seed(src, dst, key, Path(agents))
        finally:
            ledger.release(work)
        print(result)


try:
    main(MountPins)
except (ValueError, OSError, subprocess.SubprocessError, KeyError) as exc:
    sys.exit(str(exc) if not isinstance(exc, subprocess.SubprocessError) else 'seed broker command failed')
